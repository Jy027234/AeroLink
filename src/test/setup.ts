import { Window } from 'happy-dom';

const window = new Window();
(globalThis as typeof globalThis & { window: Window }).window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
