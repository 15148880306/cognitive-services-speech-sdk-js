
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
// Multi-device Conversation is a Preview feature.

import { IDisposable } from "../../common/Exports";
import { Contracts } from "../../sdk/Contracts";
import {
    Connection,
    ConnectionEventArgs,
    Conversation,
    ConversationExpirationEventArgs,
    ConversationParticipantsChangedEventArgs,
    ConversationTranslationCanceledEventArgs,
    ConversationTranslationEventArgs,
    ConversationTranslator,
    Participant,
    ParticipantChangedReason,
    ProfanityOption,
    PropertyCollection,
    PropertyId,
    SpeechTranslationConfig} from "../../sdk/Exports";
import { SpeechTranslationConfigImpl } from "../../sdk/SpeechTranslationConfig";
import { Callback } from "../../sdk/Transcription/IConversation";
import { IParticipant, IUser } from "../../sdk/Transcription/IParticipant";
import {
    ConversationManager,
    ConversationReceivedTranslationEventArgs,
    ConversationTranslatorCommandTypes,
    ConversationTranslatorConfig,
    ConversationTranslatorMessageTypes,
    ConversationTranslatorRecognizer,
    IInternalConversation,
    IInternalParticipant,
    InternalParticipants,
    LockRoomEventArgs,
    MuteAllEventArgs,
    ParticipantAttributeEventArgs,
    ParticipantEventArgs,
    ParticipantsListEventArgs} from "./Exports";

export class ConversationImpl extends Conversation implements IDisposable {

    private privConfig: SpeechTranslationConfig;
    private privProperties: PropertyCollection;
    private privLanguage: string;
    private privToken: string;
    private privIsDisposed: boolean = false;
    private privRoom: IInternalConversation;
    private privManager: ConversationManager;
    private privConversationRecognizer: ConversationTranslatorRecognizer;
    private privConversationRecognizerConnection: Connection;
    private privIsConnected: boolean = false;
    private privParticipants: InternalParticipants;
    private privIsReady: boolean;
    private privConversationTranslator: ConversationTranslator;

    public set conversationTranslator(value: ConversationTranslator) {
        this.privConversationTranslator = value;
    }

    // get the internal data about a conversation
    public get room(): IInternalConversation {
        return this.privRoom;
    }

    // get the wrapper for connecting to the websockets
    public get connection(): ConversationTranslatorRecognizer {
        return this.privConversationRecognizer; // this.privConnection;
    }

    // get / set the speech auth token
    public get authorizationToken(): string {
        return this.privToken;
    }
    public set authorizationToken(value: string) {
        Contracts.throwIfNullOrWhitespace(value, "authorizationToken");
        this.privToken = value;
    }

    // get the config
    public get config(): SpeechTranslationConfig {
        return this.privConfig;
    }
    // get the conversation Id
    public get conversationId(): string {
        return this.privRoom ? this.privRoom.roomId : "";
    }

    // get the properties
    public get properties(): PropertyCollection {
        return this.privProperties;
    }

    // get the speech language
    public get speechRecognitionLanguage(): string {
        return this.privLanguage;
    }

    public get isMutedByHost(): boolean {
        return this.privParticipants.me?.isHost ? false : this.privParticipants.me?.isMuted;
    }

    public get isConnected(): boolean {
        return this.privIsConnected && this.privIsReady;
    }

    public get participants(): Participant[] {
        return this.toParticipants(true);
    }

    public get me(): Participant {
        return this.toParticipant(this.privParticipants.me);
    }

    public get host(): Participant {
        return this.toParticipant(this.privParticipants.host);
    }

    /**
     * Create a conversation impl
     * @param speechConfig
     */
    public constructor(speechConfig: SpeechTranslationConfig) {
        super();
        this.privProperties = new PropertyCollection();
        this.privManager = new ConversationManager();

        // check the speech language
        const language: string = speechConfig.getProperty(PropertyId[PropertyId.SpeechServiceConnection_RecoLanguage]);
        if (!language) {
            speechConfig.setProperty(PropertyId[PropertyId.SpeechServiceConnection_RecoLanguage], ConversationTranslatorConfig.defaultLanguageCode);
        }
        this.privLanguage = speechConfig.getProperty(PropertyId[PropertyId.SpeechServiceConnection_RecoLanguage]);

        // check the target language(s)
        if (speechConfig.targetLanguages.length === 0) {
            speechConfig.addTargetLanguage(this.privLanguage);
        }

        // check the profanity setting: speech and conversationTranslator should be in sync
        const profanity: string = speechConfig.getProperty(PropertyId[PropertyId.SpeechServiceResponse_ProfanityOption]);
        if (!profanity) {
           speechConfig.setProfanity(ProfanityOption.Masked);
        }

        // check the nickname: it should pass this regex: ^\w+([\s-][\w\(\)]+)*$"
        // TODO: specify the regex required. Nicknames must be unique or get the duplicate nickname error
        // TODO: check what the max length is and if a truncation is required or if the service handles it without an error
        let hostNickname: string = speechConfig.getProperty(PropertyId[PropertyId.ConversationTranslator_Name]);
        if (hostNickname === undefined || hostNickname === null || hostNickname.length <= 1 || hostNickname.length > 50) {
            hostNickname = "Host";
        }
        speechConfig.setProperty(PropertyId[PropertyId.ConversationTranslator_Name], hostNickname);

        // save the speech config for future usage
        this.privConfig = speechConfig;

        // save the config properties
        const configImpl = speechConfig as SpeechTranslationConfigImpl;
        Contracts.throwIfNull(configImpl, "speechConfig");
        this.privProperties = configImpl.properties.clone();
        this.privIsConnected = false;
        this.privParticipants = new InternalParticipants();
        this.privIsReady = false;
    }

    /**
     * Create a new conversation as Host
     * @param cb
     * @param err
     */
    public createConversationAsync(cb?: Callback, err?: Callback): void {
        try {
            if (!!this.privConversationRecognizer) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedStart), err);
            }
            this.privManager.createOrJoin(this.privProperties, undefined,
                ((room: IInternalConversation) => {
                    if (!room) {
                        this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedConnect), err);
                    }
                    this.privRoom = room;
                    this.handleCallback(cb, err);
                }),
                ((error: any) => {
                    this.handleError(error, err);
                }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Starts a new conversation as host.
     * @param cb
     * @param err
     */
    public startConversationAsync(cb?: Callback, err?: Callback): void {
        try {
            // check if there is already a recognizer
            if (!!this.privConversationRecognizer) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedStart), err);
            }
            // check if there is conversation data available
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedConnect);
            // connect to the conversation websocket
            this.privParticipants.meId = this.privRoom.participantId;
            this.privConversationRecognizer = new ConversationTranslatorRecognizer(this.privConfig);
            this.privConversationRecognizer.conversation = this.privRoom;
            this.privConversationRecognizerConnection = Connection.fromRecognizer(this.privConversationRecognizer);
            this.privConversationRecognizerConnection.connected = this.onConnected;
            this.privConversationRecognizerConnection.disconnected = this.onDisconnected;
            this.privConversationRecognizer.canceled = this.onCanceled;
            this.privConversationRecognizer.participantUpdateCommandReceived = this.onParticipantUpdateCommandReceived;
            this.privConversationRecognizer.lockRoomCommandReceived = this.onLockRoomCommandReceived;
            this.privConversationRecognizer.muteAllCommandReceived = this.onMuteAllCommandReceived;
            this.privConversationRecognizer.participantJoinCommandReceived = this.onParticipantJoinCommandReceived;
            this.privConversationRecognizer.participantLeaveCommandReceived = this.onParticipantLeaveCommandReceived;
            this.privConversationRecognizer.translationReceived = this.onTranslationReceived;
            this.privConversationRecognizer.participantsListReceived = this.onParticipantsListReceived;
            this.privConversationRecognizer.conversationExpiration = this.onConversationExpiration;
            this.privConversationRecognizer.connect(this.privRoom.token,
                (() => {
                    this.handleCallback(cb, err);
                }),
                ((error: any) => {
                    this.handleError(error, err);
                }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Join a conversation as a participant.
     * @param conversation
     * @param nickname
     * @param lang
     * @param cb
     * @param err
     */
    public joinConversationAsync(conversationId: string, nickname: string, lang: string, cb?: Callback, err?: Callback): void {
        try {
            // TODO
            // if (!!this.privConversationRecognizer) {
            //     throw new Error(ConversationTranslatorConfig.strings.permissionDeniedStart);
            // }
            Contracts.throwIfNullOrWhitespace(conversationId, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "conversationId"));
            Contracts.throwIfNullOrWhitespace(nickname, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "nickname"));
            Contracts.throwIfNullOrWhitespace(lang, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "language"));
            // join the conversation
            this.privManager.createOrJoin(this.privProperties, conversationId,
                ((room: IInternalConversation) => {
                    Contracts.throwIfNullOrUndefined(room, ConversationTranslatorConfig.strings.permissionDeniedConnect);
                    this.privRoom = room;
                    this.privConfig.authorizationToken = room.cognitiveSpeechAuthToken;
                    // join callback
                    if (!!cb) {
                        cb(room.cognitiveSpeechAuthToken);
                    }
                }),
                ((error: any) => {
                    this.handleError(error, err);
                }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Deletes a conversation
     * @param cb
     * @param err
     */
    public deleteConversationAsync(cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfNullOrUndefined(this.privProperties, ConversationTranslatorConfig.strings.permissionDeniedConnect);
            Contracts.throwIfNullOrWhitespace(this.privRoom.token, ConversationTranslatorConfig.strings.permissionDeniedConnect);
            this.privManager.leave(this.privProperties, this.privRoom.token,
                (() => {
                    this.handleCallback(cb, err);
                }),
                ((error: any) => {
                    this.handleError(error, err);
                }));
            this.dispose();
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to close the client websockets
     * @param cb
     * @param err
     */
    public endConversationAsync(cb?: Callback, err?: Callback): void {
        try {
            this.close(true);
            this.handleCallback(cb, err);
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to lock the conversation
     * @param cb
     * @param err
     */
    public lockConversationAsync(cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            if (!this.canSendAsHost) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedConversation.replace("{command}", "lock")), err);
            }
            this.privConversationRecognizer?.sendLockRequest(true,
                (() => {
                    this.handleCallback(cb, err);
                }),
                ((error: any) => {
                    this.handleError(error, err);
                }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to mute the conversation
     * @param cb
     * @param err
     */
    public muteAllParticipantsAsync(cb?: Callback, err?: Callback): void {

        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrUndefined(this.privConversationRecognizer, ConversationTranslatorConfig.strings.permissionDeniedSend);
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            // check the user's permissions
            if (!this.canSendAsHost) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedConversation.replace("{command}", "mute")), err);
            }
            this.privConversationRecognizer?.sendMuteAllRequest(true,
                (() => {
                    this.handleCallback(cb, err);
                }),
                ((error: any) => {
                    this.handleError(error, err);
                }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to mute a participant in the conversation
     * @param userId
     * @param cb
     * @param err
     */
    public muteParticipantAsync(userId: string, cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrWhitespace(userId, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "userId"));
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            // check the connection is open (host + participant can perform the mute command)
            if (!this.canSend) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedSend), err);
            }
            // if not host, check the participant is not muting another participant
            if (!this.me.isHost && this.me.id !== userId) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedParticipant.replace("{command}", "mute")), err);
            }
            // check the user exists
            const exists: number = this.privParticipants.getParticipantIndex(userId);
            if (exists === -1) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.invalidParticipantRequest), err);
            }
            this.privConversationRecognizer?.sendMuteRequest(userId, true, (() => {
                this.handleCallback(cb, err);
            }),
            ((error: any) => {
                this.handleError(error, err);
            }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to remove a participant from the conversation
     * @param userId
     * @param cb
     * @param err
     */
    public removeParticipantAsync(userId: string | IParticipant | IUser, cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            if (!this.canSendAsHost) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedParticipant.replace("{command}", "remove")), err);
            }
            let participantId: string = "";
            if (typeof userId === "string") {
                participantId = userId as string;
            } else if (userId.hasOwnProperty("id")) {
                const participant: IParticipant = userId as IParticipant;
                participantId = participant.id;
            } else if (userId.hasOwnProperty("userId")) {
                const user: IUser = userId as IUser;
                participantId = user.userId;
            }
            Contracts.throwIfNullOrWhitespace(participantId, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "userId"));
            // check the participant exists
            const index: number = this.participants.findIndex((p: Participant) => p.id === participantId);
            if (index === -1) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.invalidParticipantRequest), err);
            }
            this.privConversationRecognizer?.sendEjectRequest(participantId, (() => {
                this.handleCallback(cb, err);
            }),
            ((error: any) => {
                this.handleError(error, err);
            }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to unlock the conversation
     * @param cb
     * @param err
     */
    public unlockConversationAsync(cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            if (!this.canSendAsHost) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedConversation.replace("{command}", "unlock")), err);
            }
            this.privConversationRecognizer?.sendLockRequest(false, (() => {
                this.handleCallback(cb, err);
            }),
            ((error: any) => {
                this.handleError(error, err);
            }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to unmute all participants in the conversation
     * @param cb
     * @param err
     */
    public unmuteAllParticipantsAsync(cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            if (!this.canSendAsHost) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedConversation.replace("{command}", "unmute all")), err);
            }
            this.privConversationRecognizer?.sendMuteAllRequest(false, (() => {
                this.handleCallback(cb, err);
            }),
            ((error: any) => {
                this.handleError(error, err);
            }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Issues a request to unmute a participant in the conversation
     * @param userId
     * @param cb
     * @param err
     */
    public unmuteParticipantAsync(userId: string, cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrWhitespace(userId, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "userId"));
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            // check the connection is open (host + participant can perform the mute command)
            if (!this.canSend) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedSend), err);
            }
            // if not host, check the participant is not muting another participant
            if (!this.me.isHost && this.me.id !== userId) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedParticipant.replace("{command}", "mute")), err);
            }
            // check the user exists
            const exists: number = this.privParticipants.getParticipantIndex(userId);
            if (exists === -1) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.invalidParticipantRequest), err);
            }
            this.privConversationRecognizer?.sendMuteRequest(userId, false, (() => {
                this.handleCallback(cb, err);
            }),
            ((error: any) => {
                this.handleError(error, err);
            }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    /**
     * Send a text message
     * @param message
     * @param cb
     * @param err
     */
    public sendTextMessageAsync(message: string, cb?: Callback, err?: Callback): void {
        try {
            Contracts.throwIfDisposed(this.privIsDisposed);
            Contracts.throwIfDisposed(this.privConversationRecognizer.isDisposed());
            Contracts.throwIfNullOrWhitespace(message, ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "message"));
            Contracts.throwIfNullOrUndefined(this.privRoom, ConversationTranslatorConfig.strings.permissionDeniedSend);
            if (!this.canSend) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.permissionDeniedSend), err);
            }
            // TODO: is a max length check required?
            if (message.length > ConversationTranslatorConfig.textMessageMaxLength) {
                this.handleError(new Error(ConversationTranslatorConfig.strings.invalidArgs.replace("{arg}", "message length")), err);
            }
            this.privConversationRecognizer?.sendMessageRequest(message, (() => {
                this.handleCallback(cb, err);
            }),
            ((error: any) => {
                this.handleError(error, err);
            }));
        } catch (error) {
            this.handleError(error, err);
        }
    }

    public isDisposed(): boolean {
        return this.privIsDisposed;
    }

    public dispose(reason?: string): void {
        if (this.isDisposed) {
            return;
        }
        this.privIsDisposed = true;
        this.config?.close();
        if (this.privConversationRecognizerConnection) {
            this.privConversationRecognizerConnection.closeConnection();
            this.privConversationRecognizerConnection.close();
            this.privConversationRecognizerConnection = undefined;
        }
        this.privConfig = undefined;
        this.privLanguage = undefined;
        this.privProperties = undefined;
        this.privRoom = undefined;
        this.privToken = undefined;
        this.privManager = undefined;
        this.privConversationRecognizer = undefined;
        this.privIsConnected = false;
        this.privIsReady = false;
        this.privParticipants = undefined;
        this.privRoom = undefined;
    }

    /** websocket callbacks */
    private onConnected = (e: ConnectionEventArgs): void => {
        this.privIsConnected = true;
        try {
            if (!!this.privConversationTranslator.sessionStarted) {
                this.privConversationTranslator.sessionStarted(this.privConversationTranslator, e);
            }
        } catch (e) {
            //
        }
     }

     private onDisconnected =  (e: ConnectionEventArgs): void => {
        this.close(false);
        try {
            if (!!this.privConversationTranslator.sessionStopped) {
                this.privConversationTranslator.sessionStopped(this.privConversationTranslator, e);
            }
        } catch (e) {
            //
        }
    }

    private onCanceled = (r: ConversationTranslatorRecognizer, e: ConversationTranslationCanceledEventArgs): void => {
        this.close(false); // ?
        try {
            if (!!this.privConversationTranslator.canceled) {
                this.privConversationTranslator.canceled(this.privConversationTranslator, e);
            }
        } catch (e) {
           //
        }
    }

    private onParticipantUpdateCommandReceived = (r: ConversationTranslatorRecognizer, e: ParticipantAttributeEventArgs): void => {
        try {
            const updatedParticipant: any = this.privParticipants.getParticipant(e.id);
            if (updatedParticipant !== undefined) {

                switch (e.key) {
                    case ConversationTranslatorCommandTypes.changeNickname:
                        updatedParticipant.displayName = e.value;
                        break;
                    case ConversationTranslatorCommandTypes.setUseTTS:
                        updatedParticipant.useTts = e.value;
                        break;
                    case ConversationTranslatorCommandTypes.setProfanityFiltering:
                        updatedParticipant.profanity = e.value;
                        break;
                    case ConversationTranslatorCommandTypes.setMute:
                        updatedParticipant.isMuted = e.value;
                        break;
                    case ConversationTranslatorCommandTypes.setTranslateToLanguages:
                        updatedParticipant.translateToLanguages = e.value;
                        break;
                }
                this.privParticipants.addOrUpdateParticipant(updatedParticipant);

                if (!!this.privConversationTranslator?.participantsChanged) {
                    this.privConversationTranslator?.participantsChanged(
                        this.privConversationTranslator,
                        new ConversationParticipantsChangedEventArgs(ParticipantChangedReason.Updated,
                        [this.toParticipant(updatedParticipant)], e.sessionId));
                }
            }
        } catch (e) {
            //
        }
    }

    private onLockRoomCommandReceived = (r: ConversationTranslatorRecognizer, e: LockRoomEventArgs): void => {
        // TODO
    }

    private onMuteAllCommandReceived = (r: ConversationTranslatorRecognizer, e: MuteAllEventArgs): void => {
        try {
            this.privParticipants.participants.forEach((p: IInternalParticipant) => p.isMuted = (p.isHost ? false : e.isMuted));
            if (!!this.privConversationTranslator?.participantsChanged) {
                this.privConversationTranslator?.participantsChanged(
                    this.privConversationTranslator,
                    new ConversationParticipantsChangedEventArgs(ParticipantChangedReason.Updated,
                    this.toParticipants(false), e.sessionId));
            }
        } catch (e) {
            //
        }
    }

    private onParticipantJoinCommandReceived = (r: ConversationTranslatorRecognizer, e: ParticipantEventArgs): void => {
        try {
            const newParticipant: IInternalParticipant = this.privParticipants.addOrUpdateParticipant(e.participant);
            if (newParticipant !== undefined) {
                if (!!this.privConversationTranslator?.participantsChanged) {
                    this.privConversationTranslator?.participantsChanged(
                        this.privConversationTranslator,
                        new ConversationParticipantsChangedEventArgs(ParticipantChangedReason.JoinedConversation,
                        [this.toParticipant(newParticipant)], e.sessionId));
                }
            }
        } catch (e) {
            //
        }
    }

    private onParticipantLeaveCommandReceived = (r: ConversationTranslatorRecognizer, e: ParticipantEventArgs): void => {
        try {
            const ejectedParticipant: IInternalParticipant = this.privParticipants.getParticipant(e.participant.id);
            if (ejectedParticipant !== undefined) {
                // remove the participant from the internal participants list
                this.privParticipants.deleteParticipant(e.participant.id);
                if (!!this.privConversationTranslator?.participantsChanged) {
                    // notify subscribers that the participant has left the conversation
                    this.privConversationTranslator?.participantsChanged(
                        this.privConversationTranslator,
                        new ConversationParticipantsChangedEventArgs(ParticipantChangedReason.LeftConversation,
                        [this.toParticipant(ejectedParticipant)], e.sessionId));
                }
            }
        } catch (e) {
            //
        }
    }

    private onTranslationReceived = (r: ConversationTranslatorRecognizer, e: ConversationReceivedTranslationEventArgs): void => {
        try {
            switch (e.command) {
                case ConversationTranslatorMessageTypes.final:
                    if (!!this.privConversationTranslator?.transcribed) {
                        this.privConversationTranslator?.transcribed(
                            this.privConversationTranslator,
                            new ConversationTranslationEventArgs(e.payload, undefined, e.sessionId));
                    }
                    break;
                case ConversationTranslatorMessageTypes.partial:
                    if (!!this.privConversationTranslator?.transcribing) {
                        this.privConversationTranslator?.transcribing(
                            this.privConversationTranslator,
                            new ConversationTranslationEventArgs(e.payload, undefined, e.sessionId));
                    }
                    break;
                case ConversationTranslatorMessageTypes.instantMessage:
                    if (!!this.privConversationTranslator?.textMessageReceived) {
                        this.privConversationTranslator?.textMessageReceived(
                            this.privConversationTranslator,
                            new ConversationTranslationEventArgs(e.payload, undefined, e.sessionId));
                    }
                    break;
            }
        } catch (e) {
            //
        }
    }

    private onParticipantsListReceived = (r: ConversationTranslatorRecognizer, e: ParticipantsListEventArgs): void => {
        try {
            // check if the session token needs to be updated
            if (e.sessionToken !== undefined && e.sessionToken !== null) {
                this.privRoom.token = e.sessionToken;
            }
            // save the participants
            this.privParticipants.participants = [...e.participants];
            // enable the conversation
            if (this.privParticipants.me !== undefined) {
                this.privIsReady = true;
            }
            if (!!this.privConversationTranslator?.participantsChanged) {
                this.privConversationTranslator?.participantsChanged(
                    this.privConversationTranslator,
                    new ConversationParticipantsChangedEventArgs(ParticipantChangedReason.JoinedConversation, this.toParticipants(true), e.sessionId));
            }
        } catch (e) {
            //
        }
    }

    private onConversationExpiration = (r: ConversationTranslatorRecognizer, e: ConversationExpirationEventArgs): void => {
        try {
            if (!!this.privConversationTranslator?.conversationExpiration) {
                this.privConversationTranslator?.conversationExpiration(
                    this.privConversationTranslator,
                    e);
            }
        } catch (e) {
            //
        }
    }

    private close(dispose: boolean): void {
         try {
             this.privIsConnected = false;
             this.privConversationRecognizerConnection?.closeConnection();
             this.privConversationRecognizerConnection?.close();
             this.privConversationRecognizer.close();
             this.privConversationRecognizerConnection = undefined;
             this.privConversationRecognizer = undefined;
             this.privConversationTranslator?.dispose();
         } catch (e) {
             // ignore error
         }
         if (dispose) {
            this.dispose();
         }
     }

     /** Helpers */
     private get canSend(): boolean {
         return this.privIsConnected && !this.privParticipants.me?.isMuted;
     }

     private get canSendAsHost(): boolean {
         return this.privIsConnected && this.privParticipants.me?.isHost;
     }

     private handleCallback(cb: any, err: any): void {
        if (!!cb) {
            try {
                cb();
            } catch (e) {
                if (!!err) {
                    err(e);
                }
            }
            cb = undefined;
        }
     }

     private handleError(error: any, err: any): void {
        if (!!err) {
            if (error instanceof Error) {
                const typedError: Error = error as Error;
                err(typedError.name + ": " + typedError.message);

            } else {
                err(error);
            }
        }
    }

     /** Participant Helpers */
     private toParticipants(includeHost: boolean): Participant[] {

         const participants: Participant[] = this.privParticipants.participants.map((p: IInternalParticipant) => {
             return this.toParticipant(p);
         });
         if (!includeHost) {
             return participants.filter((p: Participant) => p.isHost === false);
         } else {
             return participants;
         }
     }

     private toParticipant(p: IInternalParticipant): Participant {
         return new Participant(p.id, p.avatar, p.displayName, p.isHost, p.isMuted, p.isUsingTts, p.preferredLanguage);
     }

}
