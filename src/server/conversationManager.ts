//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
//
// Microsoft Bot Framework: http://botframework.com
//
// Bot Framework Emulator Github:
// https://github.com/Microsoft/BotFramwork-Emulator
//
// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

import * as request from 'request';
import * as http from 'http';
import * as ngrok from './ngrok';
import { IUser } from '../types/userTypes';
import { IChannelAccount, IConversationAccount } from '../types/accountTypes';
import { IActivity, IConversationUpdateActivity, IMessageActivity } from '../types/activityTypes';
import { uniqueId } from '../utils';
import { getSettings, authenticationSettings, addSettingsListener } from './settings';
import { Settings } from '../types/serverSettingsTypes';
import * as jwt from 'jsonwebtoken';
import * as oid from './OpenIdMetadata';
import * as HttpStatus from "http-status-codes";
import * as ResponseTypes from '../types/responseTypes';
import { ErrorCodes, IResourceResponse, IErrorResponse } from '../types/responseTypes';
import { emulator } from './emulator';
import * as log from './log';
import * as utils from '../utils';


/**
 * Stores and propagates conversation messages.
 */
export class Conversation {
    private accessToken: string;
    private accessTokenExpires: number;

    constructor(botId: string, conversationId: string, user: IUser) {
        this.botId = botId;
        this.conversationId = conversationId;
        this.members.push({ id: botId });
        this.members.push({ id: user.id, name: user.name });
    }

    // the botId this conversation is with
    public botId: string;

    // the id for this conversation
    public conversationId: string;

    // the list of activities in this conversation
    public activities: IActivity[] = [];

    public members: IChannelAccount[] = [];

    private postage(recipientId: string, activity: IActivity) {
        activity.id = activity.id || uniqueId();
        activity.channelId = 'emulator';
        activity.timestamp = (new Date()).toISOString();
        activity.recipient = { id: recipientId };
        activity.conversation = { id: this.conversationId };
    }

    /**
     * Sends the activity to the conversation's bot.
     */
    postActivityToBot(activity: IActivity, recordInConversation: boolean, cb?) {
        this.postage(this.botId, activity);
        const bot = getSettings().botById(this.botId);
        if (bot) {
            let options: request.OptionsWithUrl = { url: bot.botUrl, method: "POST", json: activity };

            let responseCallback = (err, resp: http.IncomingMessage, body) => {
                let messageActivity: IMessageActivity = activity;
                let text: string = messageActivity.text || '';
                if (text && text.length > 50)
                    text = text.substring(0, 50);

                if (err) {
                    log.error(err.message);
                } else if (resp) {
                    if (!/^2\d\d$/.test(`${resp.statusCode}`)) {
                        log.error(
                            '->',
                            log.makeInspectorLink("POST", activity),
                            log.makeInspectorLink(`${resp.statusCode}`, body, `(${resp.statusMessage})`),
                            `[${activity.type}]`,
                            text);
                        if(Number(resp.statusCode) == 401 || Number(resp.statusCode) == 402) {
                            log.error("Error: The bot's MSA appId or passsword is incorrect.");
                            log.error(log.botCredsConfigurationLink('Click here'), "to edit your bot's MSA info.");
                        }
                        cb(err, resp ? resp.statusCode : undefined);
                    } else {
                        log.info(
                            '->',
                            log.makeInspectorLink("POST", activity),
                            log.makeInspectorLink(`${resp.statusCode}`, body, `(${resp.statusMessage})`),
                            `[${activity.type}]`,
                            text);
                        if (recordInConversation) {
                            this.activities.push(Object.assign({}, activity));
                        }
                        cb(null, resp.statusCode, activity.id);
                    }
                }
            }

            if (!utils.isLocalhostUrl(bot.botUrl) && utils.isLocalhostUrl(emulator.framework.serviceUrl)) {
                log.error('Error: The bot is running remotely, but the callback URL is localhost.');
                log.error('Without tunneling software you will not receive replies.');
                log.error(log.ngrokConfigurationLink('Click here'), 'to configure ngrok tunneling software.');
            }

            if (bot.msaAppId && bot.msaPassword) {
                this.authenticatedRequest(options, responseCallback);
            } else {
                request(options, responseCallback);
            }
        } else {
            cb("bot not found");
        }
    }

    sendBotAddedToConversation() {
        const activity: IConversationUpdateActivity = {
            type: 'conversationUpdate',
            channelId: 'emulator',
            serviceUrl: emulator.framework.serviceUrl,
            from: {
                id: this.conversationId
            },
            membersAdded: [{ id: this.botId }]
        }
        this.postActivityToBot(activity, false, () => {});
    }

    /**
     * Queues activity for delivery to user.
     */
    public postActivityToUser(activity: IActivity): IResourceResponse {
        this.postage('', activity);
        const botId = activity.from.id;
        const settings = getSettings();
        if (!activity.from.name) {
            activity.from.name = "Bot";
        }
        this.activities.push(Object.assign({}, activity));
        return ResponseTypes.createResourceResponse(activity.id);
    }

    // updateActivity with replacement
    public updateActivity(updatedActivity: IActivity): IResourceResponse {
        // if we found the activity to reply to
        let oldActivity = this.activities.find((val) => val.id == updatedActivity.id);
        if (oldActivity) {
            Object.assign(oldActivity, updatedActivity);
            return ResponseTypes.createResourceResponse(updatedActivity.id);
        }

        throw ResponseTypes.createAPIException(HttpStatus.NOT_FOUND, ErrorCodes.BadArgument, "not a known activity id");
    }

    public deleteActivity(id: string) {
        // if we found the activity to reply to
        let index = this.activities.findIndex((val) => val.id == id);
        if (index >= 0) {
            this.activities.splice(index, 1);
            return;
        }
        throw ResponseTypes.createAPIException(HttpStatus.NOT_FOUND, ErrorCodes.BadArgument, "The activity id was not found");
    }

    // add member
    public addMember(id: string, name: string): IChannelAccount {
        let user: IChannelAccount = {
            id: id,
            name: name
        };
        this.members.push(user);
        return user;
    }

    public removeMember(id: string) {
        let index = this.members.findIndex((val) => val.id == id);
        if (index >= 0) {
            this.members.splice(index, 1);
        }
    }

    /**
     * Returns activities since the watermark.
     */
    getActivitiesSince(watermark: number): IActivity[] {
        return this.activities.slice(watermark);
    }

    private authenticatedRequest(options: request.OptionsWithUrl, callback: (error: any, response: http.IncomingMessage, body: any) => void, refresh = false): void {
        if (refresh) {
            this.accessToken = null;
        }
        this.addAccessToken(options, (err) => {
            if (!err) {
                request(options, (err, response, body) => {
                    if (!err) {
                        switch (response.statusCode) {
                            case HttpStatus.UNAUTHORIZED:
                            case HttpStatus.FORBIDDEN:
                                if (!refresh) {
                                    this.authenticatedRequest(options, callback, true);
                                } else {
                                    callback(null, response, body);
                                }
                                break;
                            default:
                                if (response.statusCode < 400) {
                                    callback(null, response, body);
                                } else {
                                    let txt = "Request to '" + options.url + "' failed: [" + response.statusCode + "] " + response.statusMessage;
                                    callback(new Error(txt), response, null);
                                }
                                break;
                        }
                    } else {
                        callback(err, null, null);
                    }
                });
            } else {
                callback(err, null, null);
            }
        });
    }

    public getAccessToken(cb: (err: Error, accessToken: string) => void): void {
        if (!this.accessToken || new Date().getTime() >= this.accessTokenExpires) {
            const bot = getSettings().botById(this.botId);
            // Refresh access token
            let opt: request.OptionsWithUrl = {
                method: 'POST',
                url: authenticationSettings.refreshEndpoint,
                form: {
                    grant_type: 'client_credentials',
                    client_id: bot.msaAppId,
                    client_secret: bot.msaPassword,
                    scope: authenticationSettings.refreshScope
                }
            };
            request(opt, (err, response, body) => {
                if (!err) {
                    if (body && response.statusCode < 300) {
                        // Subtract 5 minutes from expires_in so they'll we'll get a
                        // new token before it expires.
                        let oauthResponse = JSON.parse(body);
                        this.accessToken = oauthResponse.access_token;
                        this.accessTokenExpires = new Date().getTime() + ((oauthResponse.expires_in - 300) * 1000);
                        cb(null, this.accessToken);
                    } else {
                        cb(new Error('Refresh access token failed with status code: ' + response.statusCode), null);
                    }
                } else {
                    cb(err, null);
                }
            });
        } else {
            cb(null, this.accessToken);
        }
    }

    private addAccessToken(options: request.Options, cb: (err: Error) => void): void {
        const bot = getSettings().botById(this.botId);

        if (bot.msaAppId && bot.msaPassword) {
            this.getAccessToken((err, token) => {
                if (!err && token) {
                    options.headers = {
                        'Authorization': 'Bearer ' + token
                    };
                    cb(null);
                } else {
                    cb(err);
                }
            });
        } else {
            cb(null);
        }
    }
}

/**
 * A set of conversations with a bot.
 */
class ConversationSet {
    botId: string;
    conversations: Conversation[] = [];

    constructor(botId: string) {
        this.botId = botId;
    }

    newConversation(user: IUser): Conversation {
        const conversation = new Conversation(this.botId, uniqueId(), user);
        this.conversations.push(conversation);
        return conversation;
    }

    conversationById(conversationId: string): Conversation {
        return this.conversations.find(value => value.conversationId === conversationId);
    }


}


/**
 * Container for conversations.
 */
export class ConversationManager {
    conversationSets: ConversationSet[] = [];
    constructor() {
        addSettingsListener((settings: Settings) => {
            this.configure(settings);
        });
        this.configure(getSettings());
    }

    /**
     * Applies configuration changes.
     */
    private configure(settings: Settings) {
        // Remove conversations that reference nonexistent bots.
        const deadBotIds = this.conversationSets.filter(set => !settings.bots.find(bot => bot.botId === set.botId)).map(conversation => conversation.botId);
        this.conversationSets = this.conversationSets.filter(set => !deadBotIds.find(botId => set.botId === botId));
    }

    /**
     * Creates a new conversation.
     */
    public newConversation(botId: string, user: IUser): Conversation {
        let conversationSet = this.conversationSets.find(value => value.botId === botId);
        if (!conversationSet) {
            conversationSet = new ConversationSet(botId);
            this.conversationSets.push(conversationSet);
        }
        let conversation = conversationSet.newConversation(user);
        return conversation;
    }

    /**
     * Gets the existing conversation, or returns undefined.
     */
    public conversationById(botId: string, conversationId: string): Conversation {
        const set = this.conversationSets.find(set => set.botId === botId);
        if (set) {
            return set.conversationById(conversationId);
        }
    }
}
