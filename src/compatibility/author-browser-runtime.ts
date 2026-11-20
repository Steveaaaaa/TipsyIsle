import popoverPolyfill from '@oddbird/popover-polyfill?raw';

// Run in each author document before its scripts. Native browsers remain
// unchanged; the bundled implementation also works offline on Android.
export const authorBrowserRuntime = '<script>\n' + popoverPolyfill.replace(/<\/script/gi, '<\\/script') + '\n</script>';
