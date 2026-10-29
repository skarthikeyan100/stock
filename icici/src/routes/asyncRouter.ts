import express from 'express';

// Express 4 does not catch a rejected promise from an async handler/middleware: left alone it becomes an unhandled rejection that can
// take the whole frontend down. Every handler registered through get/post/put/patch/delete on a route table made here (and on the app
// itself, see server.ts) is wrapped so a rejection is forwarded to the error middleware at the bottom of server.ts instead.
export function wrapAsyncHandlers(target: express.Application | express.Router): void {
    for (const verb of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const original = (target as any)[verb].bind(target);
        (target as any)[verb] = (...args: any[]) => {
            if (verb === 'get' && args.length === 1) return original(...args); // app.get(setting)
            const wrapped = args.map((a) => {
                if (typeof a !== 'function' || a.length === 4) return a;
                return (req: express.Request, res: express.Response, next: express.NextFunction) => {
                    try {
                        const r = a(req, res, next);
                        if (r && typeof r.catch === 'function') r.catch(next);
                    } catch (e) {
                        next(e);
                    }
                };
            });
            return original(...wrapped);
        };
    }
}

export function asyncRouter(): express.Router {
    const router = express.Router();
    wrapAsyncHandlers(router);
    return router;
}
