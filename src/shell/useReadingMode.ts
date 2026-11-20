import { useCallback, useEffect, useRef, useState } from 'react';
import { observeReadingActivity } from './reading-navigation';

export function useReadingMode(session: string) {
    const [reading, setReading] = useState(false);
    const gesture = useRef({ first: 0, last: 0, count: 0 });
    const restore = useCallback(() => {
        gesture.current = { first: 0, last: 0, count: 0 };
        setReading(false);
    }, []);
    useEffect(restore, [session, restore]);
    const onReadingActivity = useCallback((kind?: 'scroll' | 'tap') => {
        if (kind === 'tap') {
            if (window.matchMedia('(max-width: 1024px)').matches) restore();
            return;
        }
        const now = Date.now();
        const current = gesture.current;
        if (!current.first || now - current.last > 2200) {
            gesture.current = { first: now, last: now, count: 1 };
            return;
        }
        current.last = now;
        current.count++;
        if (now - current.first >= 1400 && current.count >= 3) setReading(true);
    }, [restore]);
    useEffect(() => {
        if (!reading) return;
        return observeReadingActivity(window, kind => {
            if (kind === 'tap' && !document.querySelector('dialog[open]')) onReadingActivity(kind);
        });
    }, [reading, onReadingActivity]);
    const compact = useCallback(() => setReading(true), []);
    return { reading, restore, compact, onReadingActivity };
}
