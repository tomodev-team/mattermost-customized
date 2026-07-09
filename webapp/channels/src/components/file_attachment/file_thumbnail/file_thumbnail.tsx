// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {memo} from 'react';

import type {FileInfo} from '@mattermost/types/files';

import {getFilePreviewUrl, getFileThumbnailUrl, getFileUrl} from 'mattermost-redux/utils/file_utils';

import type {FilePreviewInfo} from 'components/file_preview/file_preview';

import Constants, {FileTypes} from 'utils/constants';
import {getFileTypeFromMime, isHeavyMediaFile} from 'utils/file_utils';
import {
    getFileType,
    getIconClassName,
    isGIFImage,
} from 'utils/utils';

type FilePreviewInfoLimited = Pick<FilePreviewInfo, 'clientId' | 'name' | 'percent' | 'type'>;

type Props = {
    enableSVGs: boolean;
    fileInfo: FileInfo | FilePreviewInfo | FilePreviewInfoLimited;
    disablePreview?: boolean;
    isRejected?: boolean;
    usePreviewImage?: boolean;
};

const FileThumbnail = ({
    fileInfo,
    enableSVGs,
    disablePreview,
    isRejected,
    usePreviewImage,
}: Props) => {
    const {id, extension, has_preview_image: hasPreviewImage, width = 0, height = 0} = (fileInfo as FileInfo);
    const mimeType = (fileInfo as FileInfo).mime_type || (fileInfo as FilePreviewInfo | FilePreviewInfoLimited).type;

    let type = FileTypes.OTHER;
    if (extension) {
        type = getFileType(extension);
    } else if (mimeType) {
        type = getFileTypeFromMime(mimeType);
    }

    // If the file is rejected, always show the file icon instead of thumbnail
    if (id && !disablePreview && !isRejected && !isHeavyMediaFile(fileInfo)) {
        if (type === FileTypes.IMAGE) {
            let className = 'post-image';

            if (width < Constants.THUMBNAIL_WIDTH && height < Constants.THUMBNAIL_HEIGHT) {
                className += ' small';
            } else {
                className += ' normal';
            }

            let thumbnailUrl = usePreviewImage && hasPreviewImage ? getFilePreviewUrl(id) : getFileThumbnailUrl(id);
            if (extension && isGIFImage(extension) && !hasPreviewImage) {
                thumbnailUrl = getFileUrl(id);
            }

            return (
                <div
                    className={className}
                    style={{
                        backgroundImage: `url(${thumbnailUrl})`,
                        backgroundSize: 'cover',
                    }}
                />
            );
        } else if (extension === FileTypes.SVG && enableSVGs) {
            return (
                <img
                    alt={'file thumbnail image'}
                    className='post-image normal'
                    src={getFileUrl(id)}
                />
            );
        } else if (type === FileTypes.VIDEO) {
            return (
                <video
                    aria-label='video thumbnail'
                    className='post-image normal'
                    muted={true}
                    playsInline={true}
                    preload='metadata'
                    src={getFileUrl(id)}
                />
            );
        }
    }

    return <div className={'file-icon ' + getIconClassName(type)}/>;
};

export default memo(FileThumbnail);
