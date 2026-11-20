import { useState } from 'react';
import { Icon } from './Icon';

export function CharacterAvatar({ name, avatar, className = '', fallback = 'initial' }: {
    name: string; avatar?: string; className?: string; fallback?: 'initial' | 'user';
}) {
    const [failedSource, setFailedSource] = useState('');
    const showImage = avatar && avatar !== 'default.png' && avatar !== failedSource;
    return <span className={`ttm-char-avatar ${className}`} aria-hidden="true">
        {showImage ? <img src={avatar} alt="" onError={() => setFailedSource(avatar)} />
            : fallback === 'user' ? <Icon name="user" className="ttm-user-avatar-placeholder" /> : name.slice(0, 1)}
    </span>;
}
