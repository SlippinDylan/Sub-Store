let httpServerFactory;

export function registerHttpServerFactory(factory) {
    httpServerFactory = factory;
}

export function getHttpServerFactory() {
    return httpServerFactory;
}
