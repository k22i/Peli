import { serve, type Request } from "./protocol";

// The ranking worker (#51): the engine off the page's thread, so parsing an
// addon's 1,400 streams never blocks a frame (#6). A worker's postMessage
// takes no target origin; nothing is transferred.
const handle = serve((update) => self.postMessage(update, { transfer: [] }));
self.addEventListener("message", (event: MessageEvent<Request>) => handle(event.data));
