/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import MockHttpBackend from "matrix-mock-request";

import { MAIN_ROOM_TIMELINE, ReceiptType, WrappedReceipt } from "../../src/@types/read_receipts";
import { MatrixClient } from "../../src/client";
import { EventType, MatrixEvent, Room } from "../../src/matrix";
import { synthesizeReceipt } from "../../src/models/read-receipt";
import { encodeUri } from "../../src/utils";
import * as utils from "../test-utils/test-utils";

// Jest now uses @sinonjs/fake-timers which exposes tickAsync() and a number of
// other async methods which break the event loop, letting scheduled promise
// callbacks run. Unfortunately, Jest doesn't expose these, so we have to do
// it manually (this is what sinon does under the hood). We do both in a loop
// until the thing we expect happens: hopefully this is the least flakey way
// and avoids assuming anything about the app's behaviour.
const realSetTimeout = setTimeout;
function flushPromises() {
    return new Promise((r) => {
        realSetTimeout(r, 1);
    });
}

let client: MatrixClient;
let httpBackend: MockHttpBackend;

const THREAD_ID = "$thread_event_id";
const ROOM_ID = "!123:matrix.org";

describe("Read receipt", () => {
    let threadEvent: MatrixEvent;
    let roomEvent: MatrixEvent;

    beforeEach(() => {
        httpBackend = new MockHttpBackend();
        client = new MatrixClient({
            userId: "@user:server",
            baseUrl: "https://my.home.server",
            accessToken: "my.access.token",
            fetchFn: httpBackend.fetchFn as typeof global.fetch,
        });
        client.isGuest = () => false;
        client.supportsThreads = () => true;

        threadEvent = utils.mkEvent({
            event: true,
            type: EventType.RoomMessage,
            user: "@bob:matrix.org",
            room: ROOM_ID,
            content: {
                "body": "Hello from a thread",
                "m.relates_to": {
                    "event_id": THREAD_ID,
                    "m.in_reply_to": {
                        event_id: THREAD_ID,
                    },
                    "rel_type": "m.thread",
                },
            },
        });
        roomEvent = utils.mkEvent({
            event: true,
            type: EventType.RoomMessage,
            user: "@bob:matrix.org",
            room: ROOM_ID,
            content: {
                body: "Hello from a room",
            },
        });
    });

    describe("sendReceipt", () => {
        it("sends a thread read receipt", async () => {
            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: threadEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(THREAD_ID);
                })
                .respond(200, {});

            client.sendReceipt(threadEvent, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("sends an unthreaded receipt", async () => {
            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: threadEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toBeUndefined();
                })
                .respond(200, {});

            client.sendReadReceipt(threadEvent, ReceiptType.Read, true);

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("sends a room read receipt", async () => {
            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: roomEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(MAIN_ROOM_TIMELINE);
                })
                .respond(200, {});

            client.sendReceipt(roomEvent, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("should send a main timeline read receipt for a reaction to a thread root", async () => {
            roomEvent.event.event_id = THREAD_ID;
            const reaction = utils.mkReaction(roomEvent, client, client.getSafeUserId(), ROOM_ID);
            const thread = new Room(ROOM_ID, client, client.getSafeUserId()).createThread(
                THREAD_ID,
                roomEvent,
                [threadEvent],
                false,
            );
            threadEvent.setThread(thread);
            reaction.setThread(thread);

            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: reaction.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(MAIN_ROOM_TIMELINE);
                })
                .respond(200, {});

            client.sendReceipt(reaction, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("should always send unthreaded receipts if threads support is disabled", async () => {
            client.supportsThreads = () => false;

            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: roomEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(undefined);
                })
                .respond(200, {});

            client.sendReceipt(roomEvent, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });
    });

    describe("synthesizeReceipt", () => {
        it.each([
            { getEvent: () => roomEvent, destinationId: MAIN_ROOM_TIMELINE },
            { getEvent: () => threadEvent, destinationId: THREAD_ID },
        ])("adds the receipt to $destinationId", ({ getEvent, destinationId }) => {
            const event = getEvent();
            const userId = "@bob:example.org";
            const receiptType = ReceiptType.Read;

            const fakeReadReceipt = synthesizeReceipt(userId, event, receiptType);

            const content = fakeReadReceipt.getContent()[event.getId()!][receiptType][userId];

            expect(content.thread_id).toEqual(destinationId);
        });
    });

    describe("addReceiptToStructure", () => {
        it("should not allow an older unthreaded receipt to clobber a `main` threaded one", () => {
            const userId = client.getSafeUserId();
            const room = new Room(ROOM_ID, client, userId);

            const unthreadedReceipt: WrappedReceipt = {
                eventId: "$olderEvent",
                data: {
                    ts: 1234567880,
                },
            };
            const mainTimelineReceipt: WrappedReceipt = {
                eventId: "$newerEvent",
                data: {
                    ts: 1234567890,
                },
            };

            room.addReceiptToStructure(
                mainTimelineReceipt.eventId,
                ReceiptType.ReadPrivate,
                userId,
                mainTimelineReceipt.data,
                false,
            );
            expect(room.getEventReadUpTo(userId)).toBe(mainTimelineReceipt.eventId);

            room.addReceiptToStructure(
                unthreadedReceipt.eventId,
                ReceiptType.ReadPrivate,
                userId,
                unthreadedReceipt.data,
                false,
            );
            expect(room.getEventReadUpTo(userId)).toBe(mainTimelineReceipt.eventId);
        });
    });
});
