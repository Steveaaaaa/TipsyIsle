export const definePlugin = definition => definition;
export const defineMigration = migration => migration;
export const isPluginApiError = error => error?.name === 'PluginApiError' && typeof error.code === 'string';
