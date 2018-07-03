/*
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd

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

import MatrixClientPeg from '../MatrixClientPeg';
import SdkConfig from "../SdkConfig";
import dis from '../dispatcher';
import * as url from "url";

export default class WidgetUtils {
    /* Returns true if user is able to send state events to modify widgets in this room
     * (Does not apply to non-room-based / user widgets)
     * @param roomId -- The ID of the room to check
     * @return Boolean -- true if the user can modify widgets in this room
     * @throws Error -- specifies the error reason
     */
    static canUserModifyWidgets(roomId) {
        if (!roomId) {
            console.warn('No room ID specified');
            return false;
        }

        const client = MatrixClientPeg.get();
        if (!client) {
            console.warn('User must be be logged in');
            return false;
        }

        const room = client.getRoom(roomId);
        if (!room) {
            console.warn(`Room ID ${roomId} is not recognised`);
            return false;
        }

        const me = client.credentials.userId;
        if (!me) {
            console.warn('Failed to get user ID');
            return false;
        }

        const member = room.getMember(me);
        if (!member || member.membership !== "join") {
            console.warn(`User ${me} is not in room ${roomId}`);
            return false;
        }

        return room.currentState.maySendStateEvent('im.vector.modular.widgets', me);
    }

    /**
     * Returns true if specified url is a scalar URL, typically https://scalar.vector.im/api
     * @param  {[type]}  testUrlString URL to check
     * @return {Boolean} True if specified URL is a scalar URL
     */
    static isScalarUrl(testUrlString) {
        if (!testUrlString) {
            console.error('Scalar URL check failed. No URL specified');
            return false;
        }

        const testUrl = url.parse(testUrlString);

        let scalarUrls = SdkConfig.get().integrations_widgets_urls;
        if (!scalarUrls || scalarUrls.length === 0) {
            scalarUrls = [SdkConfig.get().integrations_rest_url];
        }

        for (let i = 0; i < scalarUrls.length; i++) {
            const scalarUrl = url.parse(scalarUrls[i]);
            if (testUrl && scalarUrl) {
                if (
                    testUrl.protocol === scalarUrl.protocol &&
                    testUrl.host === scalarUrl.host &&
                    testUrl.pathname.startsWith(scalarUrl.pathname)
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Returns a promise that resolves when a widget with the given
     * ID has been added as a user widget (ie. the accountData event
     * arrives) or rejects after a timeout
     *
     * @param {string} widgetId The ID of the widget to wait for
     * @param {boolean} add True to wait for the widget to be added,
     *     false to wait for it to be deleted.
     * @returns {Promise} that resolves when the widget is in the
     *     requested state according to the `add` param
     */
    static waitForUserWidget(widgetId, add) {
        return new Promise((resolve, reject) => {
            // Tests an account data event, returning true if it's in the state
            // we're waiting for it to be in
            function eventInIntendedState(ev) {
                if (!ev || !ev.getContent()) return false;
                if (add) {
                    return ev.getContent()[widgetId] !== undefined;
                } else {
                    return ev.getContent()[widgetId] === undefined;
                }
            }

            const startingAccountDataEvent = MatrixClientPeg.get().getAccountData('m.widgets');
            if (eventInIntendedState(startingAccountDataEvent)) {
                resolve();
                return;
            }

            function onAccountData(ev) {
                const currentAccountDataEvent = MatrixClientPeg.get().getAccountData('m.widgets');
                if (eventInIntendedState(currentAccountDataEvent)) {
                    MatrixClientPeg.get().removeListener('accountData', onAccountData);
                    clearTimeout(timerId);
                    resolve();
                }
            }
            const timerId = setTimeout(() => {
                MatrixClientPeg.get().removeListener('accountData', onAccountData);
                reject(new Error("Timed out waiting for widget ID " + widgetId + " to appear"));
            }, 10000);
            MatrixClientPeg.get().on('accountData', onAccountData);
        });
    }

    /**
     * Returns a promise that resolves when a widget with the given
     * ID has been added as a room widget in the given room (ie. the
     * room state event arrives) or rejects after a timeout
     *
     * @param {string} widgetId The ID of the widget to wait for
     * @param {string} roomId The ID of the room to wait for the widget in
     * @param {boolean} add True to wait for the widget to be added,
     *     false to wait for it to be deleted.
     * @returns {Promise} that resolves when the widget is in the
     *     requested state according to the `add` param
     */
    static waitForRoomWidget(widgetId, roomId, add) {
        return new Promise((resolve, reject) => {
            // Tests a list of state events, returning true if it's in the state
            // we're waiting for it to be in
            function eventsInIntendedState(evList) {
                const widgetPresent = evList.some((ev) => {
                    return ev.getContent() && ev.getContent()['id'] === widgetId;
                });
                if (add) {
                    return widgetPresent;
                } else {
                    return !widgetPresent;
                }
            }

            const room = MatrixClientPeg.get().getRoom(roomId);
            const startingWidgetEvents = room.currentState.getStateEvents('im.vector.modular.widgets');
            if (eventsInIntendedState(startingWidgetEvents)) {
                resolve();
                return;
            }

            function onRoomStateEvents(ev) {
                if (ev.getRoomId() !== roomId) return;

                const currentWidgetEvents = room.currentState.getStateEvents('im.vector.modular.widgets');

                if (eventsInIntendedState(currentWidgetEvents)) {
                    MatrixClientPeg.get().removeListener('RoomState.events', onRoomStateEvents);
                    clearTimeout(timerId);
                    resolve();
                }
            }
            const timerId = setTimeout(() => {
                MatrixClientPeg.get().removeListener('RoomState.events', onRoomStateEvents);
                reject(new Error("Timed out waiting for widget ID " + widgetId + " to appear"));
            }, 10000);
            MatrixClientPeg.get().on('RoomState.events', onRoomStateEvents);
        });
    }

    static setUserWidget(widgetId, widgetType, widgetUrl, widgetName, widgetData) {
        const content = {
            type: widgetType,
            url: widgetUrl,
            name: widgetName,
            data: widgetData,
        };

        const client = MatrixClientPeg.get();
        const userWidgets = WidgetUtils.getUserWidgets();

        // Delete existing widget with ID
        try {
            delete userWidgets[widgetId];
        } catch (e) {
            console.error(`$widgetId is non-configurable`);
        }

        const addingWidget = Boolean(widgetUrl);

        // Add new widget / update
        if (addingWidget) {
            userWidgets[widgetId] = {
                content: content,
                sender: client.getUserId(),
                state_key: widgetId,
                type: 'm.widget',
                id: widgetId,
            };
        }

        // This starts listening for when the echo comes back from the server
        // since the widget won't appear added until this happens. If we don't
        // wait for this, the action will complete but if the user is fast enough,
        // the widget still won't actually be there.
        return client.setAccountData('m.widgets', userWidgets).then(() => {
            return WidgetUtils.waitForUserWidget(widgetId, addingWidget);
        }).then(() => {
            dis.dispatch({ action: "user_widget_updated" });
        });
    }

    static setRoomWidget(roomId, widgetId, widgetType, widgetUrl, widgetName, widgetData) {
        let content;

        const addingWidget = Boolean(widgetUrl);

        if (addingWidget) {
            content = {
                type: widgetType,
                url: widgetUrl,
                name: widgetName,
                data: widgetData,
            };
        } else {
            content = {};
        }

        const client = MatrixClientPeg.get();
        // TODO - Room widgets need to be moved to 'm.widget' state events
        // https://docs.google.com/document/d/1uPF7XWY_dXTKVKV7jZQ2KmsI19wn9-kFRgQ1tFQP7wQ/edit?usp=sharing
        return client.sendStateEvent(roomId, "im.vector.modular.widgets", content, widgetId).then(() => {
            return WidgetUtils.waitForRoomWidget(widgetId, roomId, addingWidget);
        });
    }

    /**
     * Get room specific widgets
     * @param  {object} room The room to get widgets force
     * @return {[object]} Array containing current / active room widgets
     */
    static getRoomWidgets(room) {
        const appsStateEvents = room.currentState.getStateEvents('im.vector.modular.widgets');
        if (!appsStateEvents) {
            return [];
        }

        return appsStateEvents.filter((ev) => {
            return ev.getContent().type && ev.getContent().url;
        });
    }

    /**
     * Get user specific widgets (not linked to a specific room)
     * @return {object} Event content object containing current / active user widgets
     */
    static getUserWidgets() {
        const client = MatrixClientPeg.get();
        if (!client) {
            throw new Error('User not logged in');
        }
        const userWidgets = client.getAccountData('m.widgets');
        if (userWidgets && userWidgets.getContent()) {
            return userWidgets.getContent();
        }
        return {};
    }

    /**
     * Get user specific widgets (not linked to a specific room) as an array
     * @return {[object]} Array containing current / active user widgets
     */
    static getUserWidgetsArray() {
        return Object.values(WidgetUtils.getUserWidgets());
    }

    /**
     * Get active stickerpicker widgets (stickerpickers are user widgets by nature)
     * @return {[object]} Array containing current / active stickerpicker widgets
     */
    static getStickerpickerWidgets() {
        const widgets = WidgetUtils.getUserWidgetsArray();
        return widgets.filter((widget) => widget.content && widget.content.type === "m.stickerpicker");
    }

    /**
     * Remove all stickerpicker widgets (stickerpickers are user widgets by nature)
     * @return {Promise} Resolves on account data updated
     */
    static removeStickerpickerWidgets() {
        const client = MatrixClientPeg.get();
        if (!client) {
            throw new Error('User not logged in');
        }
        const userWidgets = client.getAccountData('m.widgets').getContent() || {};
        Object.entries(userWidgets).forEach(([key, widget]) => {
            if (widget.content && widget.content.type === 'm.stickerpicker') {
                delete userWidgets[key];
            }
        });
        return client.setAccountData('m.widgets', userWidgets);
    }
}
