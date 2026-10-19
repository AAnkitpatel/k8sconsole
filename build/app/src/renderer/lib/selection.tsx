import { createContext, useContext, useState, type ReactNode } from 'react';

export interface Selection {
  kind: string;
  namespace?: string;
  name: string;
}

const Ctx = createContext<{ selection: Selection | null; setSelection: (s: Selection | null) => void }>({ selection: null, setSelection: () => undefined });

/** Tracks the resource the user is looking at, so the assistant can be given that context. */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  return <Ctx.Provider value={{ selection, setSelection }}>{children}</Ctx.Provider>;
}

export const useSelection = () => useContext(Ctx);
