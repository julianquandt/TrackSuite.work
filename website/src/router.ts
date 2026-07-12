/** Hash-based SPA router. */

type RouteHandler = () => void;

const routes: Record<string, RouteHandler> = {};

export function route(hash: string, handler: RouteHandler): void {
    routes[hash] = handler;
}

export function navigate(hash: string): void {
    window.location.hash = hash;
}

export function startRouter(): void {
    const handle = () => {
        const hash = window.location.hash || "#/";
        const handler = routes[hash];
        if (handler) {
            handler();
        } else {
            // Fallback to landing
            routes["#/"]?.();
        }
    };

    window.addEventListener("hashchange", handle);
    handle();
}
