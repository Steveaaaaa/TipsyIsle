import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export function ChatComposerInput(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    const input = useRef<HTMLTextAreaElement>(null);
    const resize = () => {
        const element = input.current!;
        element.style.height = 'auto';
        element.style.height = `${element.scrollHeight}px`;
    };
    useLayoutEffect(resize, [props.value, props.rows]);
    useLayoutEffect(() => {
        const element = input.current!;
        let width = element.getBoundingClientRect().width;
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === width) return;
            width = entry.contentRect.width;
            resize();
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return <textarea {...props} ref={input} />;
}
