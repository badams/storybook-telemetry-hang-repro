// Preload (NODE_OPTIONS=--import): make Node's built-in fetch use HTTP/1.1,
// which was the default before undici 8 (Node 26) enabled HTTP/2.
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ allowH2: false }));
