// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as sdk from "../microsoft.cognitiveservices.speech.sdk";
import {
    ConsoleLoggingListener,
} from "../src/common.browser/Exports";
import {
    Events,
    EventType
} from "../src/common/Exports";

import { ByteBufferAudioFile } from "./ByteBufferAudioFile";
import { Settings } from "./Settings";
import { WaveFileAudioInput } from "./WaveFileAudioInputStream";

let objsToClose: any[];

beforeAll(() => {
    // Override inputs, if necessary
    Settings.LoadSettings();
    Events.instance.attachListener(new ConsoleLoggingListener(EventType.Debug));
});

// Test cases are run linerally, still looking for a way to get the test name to print that doesn't mean changing each test.
beforeEach(() => {
    objsToClose = [];
    // tslint:disable-next-line:no-console
    console.info("---------------------------------------Starting test case-----------------------------------");
    // tslint:disable-next-line:no-console
    console.info("Start Time: " + new Date(Date.now()).toLocaleString());
});

afterEach(() => {
    // tslint:disable-next-line:no-console
    console.info("End Time: " + new Date(Date.now()).toLocaleString());
    objsToClose.forEach((value: any, index: number, array: any[]) => {
        if (typeof value.close === "function") {
            value.close();
        }
    });
});

const BuildClient: (speechConfig?: sdk.SpeechConfig) => sdk.VoiceProfileClient = (speechConfig?: sdk.SpeechConfig): sdk.VoiceProfileClient => {

    let s: sdk.SpeechConfig = speechConfig;
    if (s === undefined) {
        s = BuildSpeechConfig();
        // Since we're not going to return it, mark it for closure.
        objsToClose.push(s);
    }

    const language: string = Settings.WaveFileLanguage;
    if (s.getProperty(sdk.PropertyId[sdk.PropertyId.SpeechServiceConnection_RecoLanguage]) === undefined) {
        s.speechRecognitionLanguage = language;
    }

    const r: sdk.VoiceProfileClient = new sdk.VoiceProfileClient(s);
    expect(r).not.toBeUndefined();

    return r;
};

const BuildSpeechConfig: () => sdk.SpeechConfig = (): sdk.SpeechConfig => {
    const s: sdk.SpeechConfig = sdk.SpeechConfig.fromSubscription(Settings.SpeechSubscriptionKey, Settings.SpeechRegion);
    expect(s).not.toBeUndefined();
    return s;
};

const BuildRecognizer: (speechConfig?: sdk.SpeechConfig) => sdk.SpeakerRecognizer = (speechConfig?: sdk.SpeechConfig): sdk.SpeakerRecognizer => {

    let s: sdk.SpeechConfig = speechConfig;
    if (s === undefined) {
        s = BuildSpeechConfig();
        // Since we're not going to return it, mark it for closure.
        objsToClose.push(s);
    }

    const f: File = WaveFileAudioInput.LoadFile(Settings.DependentVerificationWaveFile);
    const config: sdk.AudioConfig = sdk.AudioConfig.fromWavFileInput(f);

    const r: sdk.SpeakerRecognizer = new sdk.SpeakerRecognizer(s, config);
    expect(r).not.toBeUndefined();

    return r;
};

test("VoiceProfileClient", () => {
    // tslint:disable-next-line:no-console
    console.info("Name: VoiceProfileClient");
    const r: sdk.VoiceProfileClient = BuildClient();
    objsToClose.push(r);
});

test("GetParameters", () => {
    // tslint:disable-next-line:no-console
    console.info("Name: GetParameters");
    const r: sdk.VoiceProfileClient = BuildClient();
    objsToClose.push(r);

    expect(r.properties).not.toBeUndefined();
});

describe.each([true, false])("Service based tests", () => {

    test("Create and Delete Voice Profile - Independent Identification", (done: jest.DoneCallback) => {
        // tslint:disable-next-line:no-console
        console.info("Name: Create and Delete Voice Profile - Independent Identification");
        const s: sdk.SpeechConfig = BuildSpeechConfig();
        objsToClose.push(s);

        const r: sdk.VoiceProfileClient = BuildClient(s);
        objsToClose.push(r);

        const type: sdk.VoiceProfileType = sdk.VoiceProfileType.TextIndependentIdentification;
        r.createProfileAsync(
            type,
            "en-us",
            (res: sdk.VoiceProfile) => {
                expect(res).not.toBeUndefined();
                expect(res.profileId).not.toBeUndefined();
                expect(res.profileType).not.toBeUndefined();
                expect(res.profileType).toEqual(type);
                const f: File = WaveFileAudioInput.LoadFile(Settings.IndependentIdentificationWaveFile);
                const config: sdk.AudioConfig = sdk.AudioConfig.fromWavFileInput(f);
                r.enrollProfileAsync(
                    res,
                    config,
                    (enrollResult: sdk.VoiceProfileEnrollmentResult) => {
                        expect(enrollResult).not.toBeUndefined();
                        expect(enrollResult.resultReason).not.toBeUndefined();
                        expect(enrollResult.resultReason).toEqual(sdk.ResultReason.EnrolledVoiceProfile);
                        expect(enrollResult.enrollmentsCount).toEqual(1);
                        expect(() => sdk.SpeakerVerificationModel.fromProfile(res)).toThrow();
                        r.resetProfileAsync(
                            res,
                            (resetResult: sdk.VoiceProfileResult) => {
                                expect(resetResult).not.toBeUndefined();
                                expect(resetResult.resultReason).not.toBeUndefined();
                                expect(resetResult.resultReason).toEqual(sdk.ResultReason.ResetVoiceProfile);
                                r.deleteProfileAsync(
                                    res,
                                    (result: sdk.VoiceProfileResult) => {
                                        expect(result).not.toBeUndefined();
                                        expect(result.resultReason).toEqual(sdk.ResultReason.DeletedVoiceProfile);
                                        done();
                                    },
                                    (error: string) => {
                                        done.fail(error);
                                    });
                            },
                            (error: string) => {
                                done.fail(error);
                            });
                    },
                    (error: string) => {
                        done.fail(error);
                    });

            },
            (error: string) => {
                done.fail(error);
            });
    });

    test("Create and Delete Voice Profile - Independent Verification", (done: jest.DoneCallback) => {
        // tslint:disable-next-line:no-console
        console.info("Name: Create and Delete Voice Profile - Independent Verification");
        const s: sdk.SpeechConfig = BuildSpeechConfig();
        objsToClose.push(s);

        const r: sdk.VoiceProfileClient = BuildClient(s);
        objsToClose.push(r);

        const type: sdk.VoiceProfileType = sdk.VoiceProfileType.TextIndependentVerification;
        r.createProfileAsync(
            type,
            "en-us",
            (res: sdk.VoiceProfile) => {
                expect(res).not.toBeUndefined();
                expect(res.profileId).not.toBeUndefined();
                expect(res.profileType).not.toBeUndefined();
                expect(res.profileType).toEqual(type);
                expect(() => sdk.SpeakerIdentificationModel.fromProfiles([res])).toThrow();
                r.deleteProfileAsync(
                    res,
                    (result: sdk.VoiceProfileResult) => {
                        expect(result).not.toBeUndefined();
                        expect(result.resultReason).toEqual(sdk.ResultReason.DeletedVoiceProfile);
                        done();
                    },
                    (error: string) => {
                        done.fail(error);
                    });
            },
            (error: string) => {
                done.fail(error);
            });
    });

    test("Create and Delete Voice Profile - Dependent Verification", (done: jest.DoneCallback) => {
        // tslint:disable-next-line:no-console
        console.info("Name: Create and Delete Voice Profile - Dependent Verification");
        const s: sdk.SpeechConfig = BuildSpeechConfig();
        objsToClose.push(s);

        const r: sdk.VoiceProfileClient = BuildClient(s);
        objsToClose.push(r);

        const type: sdk.VoiceProfileType = sdk.VoiceProfileType.TextDependentVerification;
        r.createProfileAsync(
            type,
            "en-us",
            (res: sdk.VoiceProfile) => {
                expect(res).not.toBeUndefined();
                expect(res.profileId).not.toBeUndefined();
                expect(res.profileType).not.toBeUndefined();
                expect(res.profileType).toEqual(type);
                const configs: sdk.AudioConfig[] = [];
                Settings.VerificationWaveFiles.forEach((file: string) => {
                    configs.push(sdk.AudioConfig.fromWavFileInput(WaveFileAudioInput.LoadFile(file)));
                });
                r.enrollProfileAsync(
                    res,
                    configs[0],
                    (enrollResult1: sdk.VoiceProfileEnrollmentResult) => {
                        expect(enrollResult1).not.toBeUndefined();
                        expect(enrollResult1.resultReason).not.toBeUndefined();
                        expect(enrollResult1.resultReason).toEqual(sdk.ResultReason.EnrollingVoiceProfile);
                        expect(enrollResult1.enrollmentsCount).toEqual(1);
                        r.enrollProfileAsync(
                            res,
                            configs[1],
                            (enrollResult2: sdk.VoiceProfileEnrollmentResult) => {
                                expect(enrollResult2).not.toBeUndefined();
                                expect(enrollResult2.resultReason).not.toBeUndefined();
                                expect(enrollResult2.resultReason).toEqual(sdk.ResultReason.EnrollingVoiceProfile);
                                expect(enrollResult2.enrollmentsCount).toEqual(2);
                                r.enrollProfileAsync(
                                    res,
                                    configs[2],
                                    (enrollResult3: sdk.VoiceProfileEnrollmentResult) => {
                                        expect(enrollResult3).not.toBeUndefined();
                                        expect(enrollResult3.resultReason).not.toBeUndefined();
                                        expect(enrollResult3.resultReason).toEqual(sdk.ResultReason.EnrolledVoiceProfile);
                                        expect(enrollResult3.enrollmentsCount).toEqual(3);
                                        const reco: sdk.SpeakerRecognizer = BuildRecognizer();
                                        const m: sdk.SpeakerVerificationModel = sdk.SpeakerVerificationModel.fromProfile(res);
                                        reco.recognizeOnceAsync(
                                            m,
                                            (recognizeResult: sdk.SpeakerRecognitionResult) => {
                                                expect(recognizeResult).not.toBeUndefined();
                                                expect(recognizeResult.reason).not.toBeUndefined();
                                                expect(recognizeResult.reason).toEqual(sdk.ResultReason.RecognizedSpeaker);
                                                expect(recognizeResult.profileId).toEqual(res.profileId);
                                                r.deleteProfileAsync(
                                                    res,
                                                    (result: sdk.VoiceProfileResult) => {
                                                        expect(result).not.toBeUndefined();
                                                        expect(result.resultReason).toEqual(sdk.ResultReason.DeletedVoiceProfile);
                                                        done();
                                                    },
                                                    (error: string) => {
                                                        done.fail(error);
                                                    });
                                                },
                                            (error: string) => {
                                                done.fail(error);
                                            });
                                    },
                                    (error: string) => {
                                        done.fail(error);
                                    });
                            },
                            (error: string) => {
                                done.fail(error);
                            });
                    },
                    (error: string) => {
                        done.fail(error);
                    });
            },
            (error: string) => {
                done.fail(error);
            });
    });
});
