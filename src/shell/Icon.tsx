import type { SVGProps } from 'react';

const paths = {
    trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
    book: 'M12 7C9.5 5 6.7 4.2 3.8 4.7Q3 4.85 3 5.7v11.5q0 1 .9.85C7 17.55 9.7 18.25 12 20c2.3-1.75 5-2.45 8.1-1.95q.9.15.9-.85V5.7q0-.85-.8-1C17.3 4.2 14.5 5 12 7Zm0 0v13M6.3 10.2q1.65 0 3.1.95m8.3-.95q-1.65 0-3.1.95',
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0ZM7 10h9M7 14h6',
    search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    plus: 'M12 5v14M5 12h14',
    upload: 'M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5',
    download: 'M12 3v13m-4-4 4 4 4-4M4 16v5h16v-5',
    close: 'm6 6 12 12M18 6 6 18',
    chevron: 'm9 5 7 7-7 7',
    send: 'm4 12 16-8-5 16-4-6-7-2Zm7 2 9-10',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
    palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4A8.8 8.8 0 0 0 12 3ZM7 10h.01M10 6.5h.01M15 7h.01M18 10.5h.01',
    history: 'M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v6l4 2',
    refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6',
    moon: 'M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z',
    sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    focus: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    panel: 'M3 4h18v16H3V4Zm6 0v16',
    arrow: 'M4 12h16m-6-6 6 6-6 6',
    stop: 'M6 6h12v12H6z',
    branch: 'M6 3v12a4 4 0 0 0 4 4h7M6 7h8a4 4 0 0 0 4-4M3 3h6m6 0h6m-4 13 3 3-3 3',
    check: 'm5 12 4 4L19 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    bookmark: 'M6 3h12v18l-6-4-6 4V3Z',
    plugin: 'M8 3v5m8-5v5M5 8h14v2a7 7 0 0 1-7 7v4m0-4a7 7 0 0 1-7-7V8Z',
    cpu: 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    archive: 'M4 8h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8ZM3 3h18v5H3zM10 12h4',
    copy: 'M8 8h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V8Zm8 0V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}
