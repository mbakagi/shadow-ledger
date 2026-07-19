declare module 'qrcode-svg' {
  export default class QRCode {
    constructor(opts: {
      content: string;
      padding?: number;
      width?: number;
      height?: number;
      color?: string;
      background?: string;
      ecl?: 'L' | 'M' | 'Q' | 'H';
      join?: boolean;
      xmlDeclaration?: boolean;
    });
    svg(): string;
  }
}
