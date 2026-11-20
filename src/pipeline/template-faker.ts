/** The pinned template plugin exposes the complete faker module, including its
 * locale instances (faker.fakerZH_CN), not just the default English generator. */
let modulePromise: Promise<typeof import('@faker-js/faker')> | undefined;
export function loadTemplateFaker(): Promise<typeof import('@faker-js/faker')> {
    return modulePromise ??= import('@faker-js/faker');
}
