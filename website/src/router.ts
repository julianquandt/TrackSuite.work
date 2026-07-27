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
        const raw = window.location.hash || "#/";
        // Match on the path only, ignoring any ?query (e.g. #/verify-email?token=…).
        const hash = raw.split("?")[0];
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
