/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import type { IMegolmSessionData } from "./@types/crypto";
import { Room } from "./models/room";
import { DeviceMap } from "./models/device";
import { UIAuthCallback } from "./interactive-auth";
import { AddSecretStorageKeyOpts, SecretStorageCallbacks, SecretStorageKeyDescription } from "./secret-storage";
import { VerificationRequest } from "./crypto-api/verification";
import { BackupTrustInfo, KeyBackupInfo } from "./crypto-api/keybackup";
import { ISignatures } from "./@types/signed";

/**
 * Public interface to the cryptography parts of the js-sdk
 *
 * @remarks Currently, this is a work-in-progress. In time, more methods will be added here.
 */
export interface CryptoApi {
    /**
     * Global override for whether the client should ever send encrypted
     * messages to unverified devices. This provides the default for rooms which
     * do not specify a value.
     *
     * If true, all unverified devices will be blacklisted by default
     */
    globalBlacklistUnverifiedDevices: boolean;

    /**
     * Checks if the user has previously published cross-signing keys
     *
     * This means downloading the devicelist for the user and checking if the list includes
     * the cross-signing pseudo-device.
     *
     * @returns true if the user has previously published cross-signing keys
     */
    userHasCrossSigningKeys(): Promise<boolean>;

    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param room - the room the event is in
     */
    prepareToEncrypt(room: Room): void;

    /**
     * Discard any existing megolm session for the given room.
     *
     * This will ensure that a new session is created on the next call to {@link prepareToEncrypt},
     * or the next time a message is sent.
     *
     * This should not normally be necessary: it should only be used as a debugging tool if there has been a
     * problem with encryption.
     *
     * @param roomId - the room to discard sessions for
     */
    forceDiscardSession(roomId: string): Promise<void>;

    /**
     * Get a list containing all of the room keys
     *
     * This should be encrypted before returning it to the user.
     *
     * @returns a promise which resolves to a list of
     *    session export objects
     */
    exportRoomKeys(): Promise<IMegolmSessionData[]>;

    /**
     * Import a list of room keys previously exported by exportRoomKeys
     *
     * @param keys - a list of session export objects
     * @param opts - options object
     * @returns a promise which resolves once the keys have been imported
     */
    importRoomKeys(keys: IMegolmSessionData[], opts?: ImportRoomKeysOpts): Promise<void>;

    /**
     * Get the device information for the given list of users.
     *
     * For any users whose device lists are cached (due to sharing an encrypted room with the user), the
     * cached device data is returned.
     *
     * If there are uncached users, and the `downloadUncached` parameter is set to `true`,
     * a `/keys/query` request is made to the server to retrieve these devices.
     *
     * @param userIds - The users to fetch.
     * @param downloadUncached - If true, download the device list for users whose device list we are not
     *    currently tracking. Defaults to false, in which case such users will not appear at all in the result map.
     *
     * @returns A map `{@link DeviceMap}`.
     */
    getUserDeviceInfo(userIds: string[], downloadUncached?: boolean): Promise<DeviceMap>;

    /**
     * Set whether to trust other user's signatures of their devices.
     *
     * If false, devices will only be considered 'verified' if we have
     * verified that device individually (effectively disabling cross-signing).
     *
     * `true` by default.
     *
     * @param val - the new value
     */
    setTrustCrossSignedDevices(val: boolean): void;

    /**
     * Return whether we trust other user's signatures of their devices.
     *
     * @see {@link Crypto.CryptoApi#setTrustCrossSignedDevices}
     *
     * @returns `true` if we trust cross-signed devices, otherwise `false`.
     */
    getTrustCrossSignedDevices(): boolean;

    /**
     * Get the verification status of a given device.
     *
     * @param userId - The ID of the user whose device is to be checked.
     * @param deviceId - The ID of the device to check
     *
     * @returns `null` if the device is unknown, or has not published any encryption keys (implying it does not support
     *     encryption); otherwise the verification status of the device.
     */
    getDeviceVerificationStatus(userId: string, deviceId: string): Promise<DeviceVerificationStatus | null>;

    /**
     * Mark the given device as locally verified.
     *
     * Marking a devices as locally verified has much the same effect as completing the verification dance, or receiving
     * a cross-signing signature for it.
     *
     * @param userId - owner of the device
     * @param deviceId - unique identifier for the device.
     * @param verified - whether to mark the device as verified. Defaults to 'true'.
     *
     * @throws an error if the device is unknown, or has not published any encryption keys.
     *
     * @remarks Fires {@link CryptoEvent#DeviceVerificationChanged}
     */
    setDeviceVerified(userId: string, deviceId: string, verified?: boolean): Promise<void>;

    /**
     * Checks whether cross signing:
     * - is enabled on this account and trusted by this device
     * - has private keys either cached locally or stored in secret storage
     *
     * If this function returns false, bootstrapCrossSigning() can be used
     * to fix things such that it returns true. That is to say, after
     * bootstrapCrossSigning() completes successfully, this function should
     * return true.
     *
     * @returns True if cross-signing is ready to be used on this device
     */
    isCrossSigningReady(): Promise<boolean>;

    /**
     * Get the ID of one of the user's cross-signing keys.
     *
     * @param type - The type of key to get the ID of.  One of `CrossSigningKey.Master`, `CrossSigningKey.SelfSigning`,
     *     or `CrossSigningKey.UserSigning`.  Defaults to `CrossSigningKey.Master`.
     *
     * @returns If cross-signing has been initialised on this device, the ID of the given key. Otherwise, null
     */
    getCrossSigningKeyId(type?: CrossSigningKey): Promise<string | null>;

    /**
     * Bootstrap cross-signing by creating keys if needed.
     *
     * If everything is already set up, then no changes are made, so this is safe to run to ensure
     * cross-signing is ready for use.
     *
     * This function:
     * - creates new cross-signing keys if they are not found locally cached nor in
     *   secret storage (if it has been set up)
     * - publishes the public keys to the server if they are not already published
     * - stores the private keys in secret storage if secret storage is set up.
     *
     * @param opts - options object
     */
    bootstrapCrossSigning(opts: BootstrapCrossSigningOpts): Promise<void>;

    /**
     * Checks whether secret storage:
     * - is enabled on this account
     * - is storing cross-signing private keys
     * - is storing session backup key (if enabled)
     *
     * If this function returns false, bootstrapSecretStorage() can be used
     * to fix things such that it returns true. That is to say, after
     * bootstrapSecretStorage() completes successfully, this function should
     * return true.
     *
     * @returns True if secret storage is ready to be used on this device
     */
    isSecretStorageReady(): Promise<boolean>;

    /**
     * Bootstrap the secret storage by creating a new secret storage key, add it in the secret storage and
     * store the cross signing keys in the secret storage.
     *
     * - Generate a new key {@link GeneratedSecretStorageKey} with `createSecretStorageKey`.
     *   Only if `setupNewSecretStorage` is set or if there is no AES key in the secret storage
     * - Store this key in the secret storage and set it as the default key.
     * - Call `cryptoCallbacks.cacheSecretStorageKey` if provided.
     * - Store the cross signing keys in the secret storage if
     *      - the cross signing is ready
     *      - a new key was created during the previous step
     *      - or the secret storage already contains the cross signing keys
     *
     * @param opts - Options object.
     */
    bootstrapSecretStorage(opts: CreateSecretStorageOpts): Promise<void>;

    /**
     * Get the status of our cross-signing keys.
     *
     * @returns The current status of cross-signing keys: whether we have public and private keys cached locally, and whether the private keys are in secret storage.
     */
    getCrossSigningStatus(): Promise<CrossSigningStatus>;

    /**
     * Create a recovery key (ie, a key suitable for use with server-side secret storage).
     *
     * The key can either be based on a user-supplied passphrase, or just created randomly.
     *
     * @param password - Optional passphrase string to use to derive the key,
     *      which can later be entered by the user as an alternative to entering the
     *      recovery key itself. If omitted, a key is generated randomly.
     *
     * @returns Object including recovery key and server upload parameters.
     *      The private key should be disposed of after displaying to the use.
     */
    createRecoveryKeyFromPassphrase(password?: string): Promise<GeneratedSecretStorageKey>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Device/User verification
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Returns to-device verification requests that are already in progress for the given user id.
     *
     * @param userId - the ID of the user to query
     *
     * @returns the VerificationRequests that are in progress
     */
    getVerificationRequestsToDeviceInProgress(userId: string): VerificationRequest[];

    /**
     * Finds a DM verification request that is already in progress for the given room id
     *
     * @param roomId - the room to use for verification
     *
     * @returns the VerificationRequest that is in progress, if any
     * @deprecated prefer `userId` parameter variant.
     */
    findVerificationRequestDMInProgress(roomId: string): VerificationRequest | undefined;

    /**
     * Finds a DM verification request that is already in progress for the given room and user.
     *
     * @param roomId - the room to use for verification.
     * @param userId - search for a verification request for the given user.
     *
     * @returns the VerificationRequest that is in progress, if any.
     */
    findVerificationRequestDMInProgress(roomId: string, userId?: string): VerificationRequest | undefined;

    /**
     * Send a verification request to our other devices.
     *
     * This is normally used when the current device is new, and we want to ask another of our devices to cross-sign.
     *
     * If an all-devices verification is already in flight, returns it. Otherwise, initiates a new one.
     *
     * To control the methods offered, set {@link ICreateClientOpts.verificationMethods} when creating the
     * MatrixClient.
     *
     * @returns a VerificationRequest when the request has been sent to the other party.
     */
    requestOwnUserVerification(): Promise<VerificationRequest>;

    /**
     * Request an interactive verification with the given device.
     *
     * This is normally used on one of our own devices, when the current device is already cross-signed, and we want to
     * validate another device.
     *
     * If a verification for this user/device is already in flight, returns it. Otherwise, initiates a new one.
     *
     * To control the methods offered, set {@link ICreateClientOpts.verificationMethods} when creating the
     * MatrixClient.
     *
     * @param userId - ID of the owner of the device to verify
     * @param deviceId - ID of the device to verify
     *
     * @returns a VerificationRequest when the request has been sent to the other party.
     */
    requestDeviceVerification(userId: string, deviceId: string): Promise<VerificationRequest>;

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Secure key backup
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Fetch the backup decryption key we have saved in our store.
     *
     * This can be used for gossiping the key to other devices.
     *
     * @returns the key, if any, or null
     */
    getSessionBackupPrivateKey(): Promise<Uint8Array | null>;

    /**
     * Store the backup decryption key.
     *
     * This should be called if the client has received the key from another device via secret sharing (gossiping).
     *
     * @param key - the backup decryption key
     */
    storeSessionBackupPrivateKey(key: Uint8Array): Promise<void>;

    /**
     * Get the current status of key backup.
     *
     * @returns If automatic key backups are enabled, the `version` of the active backup. Otherwise, `null`.
     */
    getActiveSessionBackupVersion(): Promise<string | null>;

    /**
     * Determine if a key backup can be trusted.
     *
     * @param info - key backup info dict from {@link MatrixClient#getKeyBackupVersion}.
     */
    isKeyBackupTrusted(info: KeyBackupInfo): Promise<BackupTrustInfo>;
}

/**
 * Options object for `CryptoApi.bootstrapCrossSigning`.
 */
export interface BootstrapCrossSigningOpts {
    /** Optional. Reset the cross-signing keys even if keys already exist. */
    setupNewCrossSigning?: boolean;

    /**
     * An application callback to collect the authentication data for uploading the keys. If not given, the keys
     * will not be uploaded to the server (which seems like a bad thing?).
     */
    authUploadDeviceSigningKeys?: UIAuthCallback<void>;
}

export class DeviceVerificationStatus {
    /**
     * True if this device has been signed by its owner (and that signature verified).
     *
     * This doesn't necessarily mean that we have verified the device, since we may not have verified the
     * owner's cross-signing key.
     */
    public readonly signedByOwner: boolean;

    /**
     * True if this device has been verified via cross signing.
     *
     * This does *not* take into account `trustCrossSignedDevices`.
     */
    public readonly crossSigningVerified: boolean;

    /**
     * TODO: tofu magic wtf does this do?
     */
    public readonly tofu: boolean;

    /**
     * True if the device has been marked as locally verified.
     */
    public readonly localVerified: boolean;

    /**
     * True if the client has been configured to trust cross-signed devices via {@link CryptoApi#setTrustCrossSignedDevices}.
     */
    private readonly trustCrossSignedDevices: boolean;

    public constructor(
        opts: Partial<DeviceVerificationStatus> & {
            /**
             * True if cross-signed devices should be considered verified for {@link DeviceVerificationStatus#isVerified}.
             */
            trustCrossSignedDevices?: boolean;
        },
    ) {
        this.signedByOwner = opts.signedByOwner ?? false;
        this.crossSigningVerified = opts.crossSigningVerified ?? false;
        this.tofu = opts.tofu ?? false;
        this.localVerified = opts.localVerified ?? false;
        this.trustCrossSignedDevices = opts.trustCrossSignedDevices ?? false;
    }

    /**
     * Check if we should consider this device "verified".
     *
     * A device is "verified" if either:
     *  * it has been manually marked as such via {@link MatrixClient#setDeviceVerified}.
     *  * it has been cross-signed with a verified signing key, **and** the client has been configured to trust
     *    cross-signed devices via {@link Crypto.CryptoApi#setTrustCrossSignedDevices}.
     *
     * @returns true if this device is verified via any means.
     */
    public isVerified(): boolean {
        return this.localVerified || (this.trustCrossSignedDevices && this.crossSigningVerified);
    }
}

/**
 * Room key import progress report.
 * Used when calling {@link CryptoApi#importRoomKeys} as the parameter of
 * the progressCallback. Used to display feedback.
 */
export interface ImportRoomKeyProgressData {
    stage: string; // TODO: Enum
    successes: number;
    failures: number;
    total: number;
}

/**
 * Options object for {@link CryptoApi#importRoomKeys}.
 */
export interface ImportRoomKeysOpts {
    /** Reports ongoing progress of the import process. Can be used for feedback. */
    progressCallback?: (stage: ImportRoomKeyProgressData) => void;
    // TODO, the rust SDK will always such imported keys as untrusted
    untrusted?: boolean;
    source?: String; // TODO: Enum (backup, file, ??)
}

/**
 * The result of a call to {@link CryptoApi.getCrossSigningStatus}.
 */
export interface CrossSigningStatus {
    /**
     * True if the public master, self signing and user signing keys are available on this device.
     */
    publicKeysOnDevice: boolean;
    /**
     * True if the private keys are stored in the secret storage.
     */
    privateKeysInSecretStorage: boolean;
    /**
     * True if the private keys are stored locally.
     */
    privateKeysCachedLocally: {
        masterKey: boolean;
        selfSigningKey: boolean;
        userSigningKey: boolean;
    };
}

/**
 * Crypto callbacks provided by the application
 */
export interface CryptoCallbacks extends SecretStorageCallbacks {
    getCrossSigningKey?: (keyType: string, pubKey: string) => Promise<Uint8Array | null>;
    saveCrossSigningKeys?: (keys: Record<string, Uint8Array>) => void;
    shouldUpgradeDeviceVerifications?: (users: Record<string, any>) => Promise<string[]>;
    /**
     * Called by {@link CryptoApi#bootstrapSecretStorage}
     * @param keyId - secret storage key id
     * @param keyInfo - secret storage key info
     * @param key - private key to store
     */
    cacheSecretStorageKey?: (keyId: string, keyInfo: SecretStorageKeyDescription, key: Uint8Array) => void;
    onSecretRequested?: (
        userId: string,
        deviceId: string,
        requestId: string,
        secretName: string,
        deviceTrust: DeviceVerificationStatus,
    ) => Promise<string | undefined>;
    getDehydrationKey?: (
        keyInfo: SecretStorageKeyDescription,
        checkFunc: (key: Uint8Array) => void,
    ) => Promise<Uint8Array>;
    getBackupKey?: () => Promise<Uint8Array>;
}

/**
 * Parameter of {@link CryptoApi#bootstrapSecretStorage}
 */
export interface CreateSecretStorageOpts {
    /**
     * Function called to await a secret storage key creation flow.
     * @returns Promise resolving to an object with public key metadata, encoded private
     *     recovery key which should be disposed of after displaying to the user,
     *     and raw private key to avoid round tripping if needed.
     */
    createSecretStorageKey?: () => Promise<GeneratedSecretStorageKey>;

    /**
     * The current key backup object. If passed,
     * the passphrase and recovery key from this backup will be used.
     */
    keyBackupInfo?: KeyBackupInfo;

    /**
     * If true, a new key backup version will be
     * created and the private key stored in the new SSSS store. Ignored if keyBackupInfo
     * is supplied.
     */
    setupNewKeyBackup?: boolean;

    /**
     * Reset even if keys already exist.
     */
    setupNewSecretStorage?: boolean;

    /**
     * Function called to get the user's
     * current key backup passphrase. Should return a promise that resolves with a Uint8Array
     * containing the key, or rejects if the key cannot be obtained.
     */
    getKeyBackupPassphrase?: () => Promise<Uint8Array>;
}

/** Types of cross-signing key */
export enum CrossSigningKey {
    Master = "master",
    SelfSigning = "self_signing",
    UserSigning = "user_signing",
}

/**
 * Information on one of the cross-signing keys.
 * @see https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3keysdevice_signingupload
 */
export interface CrossSigningKeyInfo {
    keys: { [algorithm: string]: string };
    signatures?: ISignatures;
    usage: string[];
    user_id: string;
}

/**
 * Recovery key created by {@link CryptoApi#createRecoveryKeyFromPassphrase}
 */
export interface GeneratedSecretStorageKey {
    keyInfo?: AddSecretStorageKeyOpts;
    /** The raw generated private key. */
    privateKey: Uint8Array;
    /** The generated key, encoded for display to the user per https://spec.matrix.org/v1.7/client-server-api/#key-representation. */
    encodedPrivateKey?: string;
}

export * from "./crypto-api/verification";
export * from "./crypto-api/keybackup";
