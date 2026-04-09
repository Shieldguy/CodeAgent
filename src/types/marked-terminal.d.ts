declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  export interface MarkedTerminalOptions {
    reflowText?: boolean;
    width?: number;
    tab?: number;
    unescape?: boolean;
    emoji?: boolean;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
