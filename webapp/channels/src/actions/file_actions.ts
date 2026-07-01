// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {batchActions} from 'redux-batched-actions';

import type {ServerError} from '@mattermost/types/errors';
import type {FileInfo} from '@mattermost/types/files';

import {FileTypes} from 'mattermost-redux/action_types';
import {getLogErrorAction} from 'mattermost-redux/actions/errors';
import {forceLogoutIfNecessary} from 'mattermost-redux/actions/helpers';
import {Client4} from 'mattermost-redux/client';
import {getConfig} from 'mattermost-redux/selectors/entities/general';

import type {FilePreviewInfo} from 'components/file_preview/file_preview';

import {isHeavyMediaFile} from 'utils/file_utils';
import {localizeMessage} from 'utils/utils';

import type {ThunkActionFunc} from 'types/store';

const IMAGE_DIMENSIONS_TIMEOUT_MS = 3000;

export interface UploadFile {
    file: File;
    name: string;
    type: string;
    rootId: string;
    channelId: string;
    clientId: string;
    onProgress: (filePreviewInfo: FilePreviewInfo) => void;
    onSuccess: (data: any, channelId: string, rootId: string) => void;
    onError: (err: string | ServerError, clientId: string, channelId: string, rootId: string) => void;
}

function createLocalPreviewUrl(file: File) {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        return '';
    }

    return URL.createObjectURL(file);
}

function getImageDimensions(file: File): Promise<{width?: number; height?: number}> {
    if (!file.type.startsWith('image/') || isHeavyMediaFile({size: file.size, type: file.type})) {
        return Promise.resolve({});
    }

    return new Promise((resolve) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        let resolved = false;
        let timeout: number;

        const finish = (dimensions: {width?: number; height?: number}) => {
            if (resolved) {
                return;
            }
            resolved = true;
            URL.revokeObjectURL(objectUrl);
            window.clearTimeout(timeout);
            resolve(dimensions);
        };

        img.onload = () => finish({width: img.naturalWidth, height: img.naturalHeight});
        img.onerror = () => {
            finish({});
        };
        timeout = window.setTimeout(() => finish({}), IMAGE_DIMENSIONS_TIMEOUT_MS);
        img.src = objectUrl;
    });
}

export function uploadFile({file, name, type, rootId, channelId, clientId, onProgress, onSuccess, onError}: UploadFile, isBookmark?: boolean): ThunkActionFunc<XMLHttpRequest> {
    return (dispatch, getState) => {
        dispatch({type: FileTypes.UPLOAD_FILES_REQUEST});

        const xhr = new XMLHttpRequest();
        const localPreviewUrl = createLocalPreviewUrl(file);
        let localPreviewRevoked = false;

        const revokeLocalPreviewUrl = () => {
            if (!localPreviewUrl || localPreviewRevoked) {
                return;
            }

            localPreviewRevoked = true;
            URL.revokeObjectURL(localPreviewUrl);
        };

        const notifyProgress = (percent: number) => {
            if (!onProgress) {
                return;
            }

            onProgress({
                clientId,
                localPreviewUrl,
                name,
                percent,
                type,
            } as FilePreviewInfo);
        };

        const handleSuccess = (response: {file_infos: FileInfo[]; client_ids: string[]}) => {
            revokeLocalPreviewUrl();

            const data = response.file_infos.map((fileInfo: FileInfo, index: number) => {
                return {
                    ...fileInfo,
                    clientId: response.client_ids[index],
                };
            });

            dispatch(batchActions([
                {
                    type: FileTypes.RECEIVED_UPLOAD_FILES,
                    data,
                    channelId,
                    rootId,
                },
                {
                    type: FileTypes.UPLOAD_FILES_SUCCESS,
                },
            ]));

            onSuccess?.(response, channelId, rootId);
        };

        const handleFailure = (error: string | ServerError | {message?: string}) => {
            revokeLocalPreviewUrl();

            dispatch({
                type: FileTypes.UPLOAD_FILES_FAILURE,
                clientIds: [clientId],
                channelId,
                rootId,
            });

            onError?.(error as string | ServerError, clientId, channelId, rootId);
        };

        const handleXHRErrorStatus = () => {
            let errorMessage = '';
            try {
                const errorResponse = JSON.parse(xhr.response);
                errorMessage =
                    (errorResponse?.id && errorResponse?.message) ? localizeMessage({id: errorResponse.id, defaultMessage: errorResponse.message}) : localizeMessage({id: 'file_upload.generic_error', defaultMessage: 'There was a problem uploading your files.'});
            } catch (e) {
                errorMessage = localizeMessage({id: 'file_upload.generic_error', defaultMessage: 'There was a problem uploading your files.'});
            }

            handleFailure(errorMessage);
        };

        const attachProgressHandler = () => {
            if (xhr.upload) {
                xhr.upload.onprogress = (event) => {
                    const percent = Math.floor((event.loaded / event.total) * 100);
                    notifyProgress(percent);
                };
            }
        };

        xhr.onabort = revokeLocalPreviewUrl;

        const attachNetworkErrorHandler = () => {
            if (onError) {
                xhr.onerror = () => {
                    if (xhr.readyState === 4 && xhr.responseText.length !== 0) {
                        const errorResponse = JSON.parse(xhr.response);

                        forceLogoutIfNecessary(errorResponse, dispatch, getState);

                        const uploadFailureAction = {
                            type: FileTypes.UPLOAD_FILES_FAILURE,
                            clientIds: [clientId],
                            channelId,
                            rootId,
                            error: errorResponse,
                        };

                        dispatch(batchActions([uploadFailureAction, getLogErrorAction(errorResponse)]));
                        onError(errorResponse, clientId, channelId, rootId);
                    } else {
                        const errorMessage = xhr.status === 0 || !xhr.status ? localizeMessage({id: 'file_upload.generic_error', defaultMessage: 'There was a problem uploading your files.'}) : localizeMessage({id: 'channel_loader.unknown_error', defaultMessage: 'We received an unexpected status code from the server.'}) + ' (' + xhr.status + ')';

                        handleFailure({message: errorMessage});
                    }
                };
            }
        };

        const sendLegacyUpload = () => {
            notifyProgress(0);

            let url = Client4.getFilesRoute();
            if (isBookmark) {
                url += '?bookmark=true';
            }

            xhr.open('POST', url, true);

            const client4Headers = Client4.getOptions({method: 'POST'}).headers;
            Object.keys(client4Headers).forEach((client4Header) => {
                const client4HeaderValue = client4Headers[client4Header];
                if (client4HeaderValue) {
                    xhr.setRequestHeader(client4Header, client4HeaderValue);
                }
            });

            xhr.setRequestHeader('Accept', 'application/json');

            const formData = new FormData();
            formData.append('channel_id', channelId);
            formData.append('client_ids', clientId);
            formData.append('files', file, name); // appending file in the end for steaming support

            attachProgressHandler();
            attachNetworkErrorHandler();

            xhr.onload = () => {
                if (xhr.status === 201 && xhr.readyState === 4) {
                    handleSuccess(JSON.parse(xhr.response));
                } else if (xhr.status >= 400 && xhr.readyState === 4) {
                    handleXHRErrorStatus();
                }
            };

            xhr.send(formData);
        };

        const sendUploadSession = (uploadId: string) => {
            notifyProgress(0);

            xhr.open('POST', Client4.getUploadRoute(uploadId), true);

            const client4Headers = Client4.getOptions({method: 'POST'}).headers;
            Object.keys(client4Headers).forEach((client4Header) => {
                const client4HeaderValue = client4Headers[client4Header];
                if (client4HeaderValue) {
                    xhr.setRequestHeader(client4Header, client4HeaderValue);
                }
            });

            xhr.setRequestHeader('Accept', 'application/json');

            attachProgressHandler();
            attachNetworkErrorHandler();

            xhr.onload = () => {
                if (xhr.status === 200 && xhr.readyState === 4) {
                    const fileInfo = JSON.parse(xhr.response);
                    handleSuccess({file_infos: [fileInfo], client_ids: [clientId]});
                } else if (xhr.status >= 400 && xhr.readyState === 4) {
                    handleXHRErrorStatus();
                }
            };

            xhr.send(file);
        };

        const config = getConfig(getState());
        if (isBookmark || config.EnableDirectFileUploads !== 'true') {
            sendLegacyUpload();
            return xhr;
        }

        const runDirectUpload = async () => {
            try {
                notifyProgress(0);

                const dimensionsPromise = getImageDimensions(file);
                const upload = await Client4.createUpload({
                    type: 'attachment',
                    channel_id: channelId,
                    filename: name,
                    file_size: file.size,
                });

                if (!upload.direct_upload?.url) {
                    sendUploadSession(upload.id);
                    return;
                }

                xhr.open(upload.direct_upload.method || 'PUT', upload.direct_upload.url, true);
                Object.entries(upload.direct_upload.headers || {}).forEach(([header, value]) => {
                    xhr.setRequestHeader(header, value);
                });

                attachProgressHandler();
                attachNetworkErrorHandler();

                xhr.onload = async () => {
                    if (xhr.status >= 200 && xhr.status < 300 && xhr.readyState === 4) {
                        try {
                            const dimensions = await dimensionsPromise;
                            const fileInfo = await Client4.completeUpload(upload.id, dimensions);
                            handleSuccess({file_infos: [fileInfo], client_ids: [clientId]});
                        } catch (error) {
                            forceLogoutIfNecessary(error, dispatch, getState);
                            dispatch(getLogErrorAction(error));
                            handleFailure(error as ServerError);
                        }
                    } else if (xhr.status >= 400 && xhr.readyState === 4) {
                        handleXHRErrorStatus();
                    }
                };

                xhr.send(file);
            } catch (error) {
                forceLogoutIfNecessary(error, dispatch, getState);
                dispatch(getLogErrorAction(error));
                handleFailure(error as ServerError);
            }
        };

        runDirectUpload();

        return xhr;
    };
}
