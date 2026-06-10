declare module 'mailparser' {
  export interface AddressObject {
    value: { address: string; name: string }[];
    text: string;
  }

  export interface Attachment {
    filename: string;
    contentType: string;
    content: Buffer;
  }

  export interface ParsedMail {
    from?: AddressObject;
    subject?: string;
    text?: string;
    html?: string;
    date?: Date;
    attachments?: Attachment[];
  }

  export function simpleParser(source: string | Buffer): Promise<ParsedMail>;
}

declare module 'imap-simple' {
  interface MessagePart {
    which: string;
    body: unknown;
  }

  interface MessageAttributes {
    uid: number;
  }

  interface Message {
    parts: MessagePart[];
    attributes: MessageAttributes;
  }

  interface Config {
    imap: {
      user: string;
      password: string;
      host: string;
      port: number;
      tls: boolean;
      tlsOptions: { rejectUnauthorized: boolean };
      authTimeout: number;
    };
  }

  interface ImapSimple {
    openBox(boxName: string): Promise<void>;
    search(criteria: string[], fetchOptions: unknown): Promise<Message[]>;
    addFlags(uid: number, flags: string[]): Promise<void>;
    closeBox(autoExpunge: boolean): Promise<void>;
    end(): void;
  }

  export function connect(config: Config): Promise<ImapSimple>;
  export default { connect };
}
