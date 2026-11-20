import { useState } from 'react';

export function CharacterAvatar({ name, avatar, className = '' }: { name: string; avatar?: string; className?: string }) {
    const [failedSource, setFailedSource] = useState('');
    const showImage = avatar && avatar !== 'default.png' && avatar !== failedSource;
    return <span className={`ttm-char-avatar ${className}`} aria-hidden="true">
        {showImage ? <img src={avatar} alt="" onError={() => setFailedSource(avatar)} /> : name.slice(0, 1)}
    </span>;
}
