import { createContext, useContext } from 'react';

/** Lets any view type a command into a new terminal tab (without running it). Provided by the app shell. */
export const CommandBridge = createContext<{ insertCommand: (command: string, title?: string) => void; context?: string }>({ insertCommand: () => undefined });
export const useCommandBridge = () => useContext(CommandBridge);
