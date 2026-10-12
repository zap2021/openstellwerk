import { locoNetChecksum } from "./commands.js";

export interface LocoNetDecoded {
  /** Mnemonic, e.g. "OPC_SW_REQ" */
  opcode: string;
  /** Human readable summary */
  text: string;
  checksumOk: boolean;
}

const hex = (b: number) => "0x" + b.toString(16).toUpperCase().padStart(2, "0");

const NAMES: Record<number, string> = {
  0x81: "OPC_BUSY", 0x82: "OPC_GPOFF", 0x83: "OPC_GPON", 0x85: "OPC_IDLE",
  0xa0: "OPC_LOCO_SPD", 0xa1: "OPC_LOCO_DIRF", 0xa2: "OPC_LOCO_SND", 0xa3: "OPC_LOCO_F912",
  0xb0: "OPC_SW_REQ", 0xb1: "OPC_SW_REP", 0xb2: "OPC_INPUT_REP", 0xb4: "OPC_LONG_ACK",
  0xb5: "OPC_SLOT_STAT1", 0xb6: "OPC_CONSIST_FUNC", 0xb8: "OPC_UNLINK_SLOTS", 0xb9: "OPC_LINK_SLOTS",
  0xba: "OPC_MOVE_SLOTS", 0xbb: "OPC_RQ_SL_DATA", 0xbc: "OPC_SW_STATE", 0xbd: "OPC_SW_ACK",
  0xbf: "OPC_LOCO_ADR", 0xd0: "OPC_MULTI_SENSE", 0xd4: "OPC_EXP_CMD", 0xe5: "OPC_PEER_XFER",
  0xe6: "OPC_ALM_READ", 0xe7: "OPC_SL_RD_DATA", 0xed: "OPC_IMM_PACKET", 0xef: "OPC_WR_SL_DATA",
};

const slotAddress = (lo: number, hi: number) => (hi << 7) | lo;

/** Turnout/sensor addresses on the wire are 0-based; users see them 1-based. */
function decodeBody(op: number, a: number[]): string {
  switch (op) {
    case 0x81: return "master busy";
    case 0x82: return "global power OFF";
    case 0x83: return "global power ON";
    case 0x85: return "emergency stop (IDLE)";
    case 0xa0: return `slot ${a[1]} speed ${a[2]}${a[2] === 1 ? " (e-stop)" : ""}`;
    case 0xa1: {
      const d = a[2]!;
      return `slot ${a[1]} dir ${d & 0x20 ? "reverse" : "forward"} F0=${d & 0x10 ? 1 : 0} F1-4=${(d & 0x0f).toString(2).padStart(4, "0")}`;
    }
    case 0xa2: return `slot ${a[1]} F5-8=${(a[2]! & 0x0f).toString(2).padStart(4, "0")}`;
    case 0xb0:
    case 0xb1: {
      const addr = (((a[2]! & 0x0f) << 7) | a[1]!) + 1;
      const closed = !!(a[2]! & 0x20);
      const on = !!(a[2]! & 0x10);
      return `turnout ${addr} ${closed ? "closed/green" : "thrown/red"} output ${on ? "ON" : "OFF"}${op === 0xb1 ? " (report)" : ""}`;
    }
    case 0xb2: {
      const raw = ((a[2]! & 0x0f) << 7) | a[1]!;
      const sensor = raw * 2 + ((a[2]! >> 5) & 1) + 1;
      return `sensor ${sensor} ${a[2]! & 0x10 ? "HIGH (occupied)" : "LOW (free)"}`;
    }
    case 0xb4: return `reply to ${hex(a[1]! | 0x80)}: ${a[2] === 0x7f ? "accepted" : a[2] === 0 ? "FAIL" : hex(a[2]!)}`;
    case 0xb5: return `slot ${a[1]} status ${hex(a[2]!)}`;
    case 0xba: return a[1] === 0 ? `dispatch get (to slot ${a[2]})` : `move slot ${a[1]} -> ${a[2]}${a[1] === a[2] ? " (activate)" : ""}`;
    case 0xbb: return `request slot ${a[1]} data`;
    case 0xbc: return `request state of turnout ${(((a[2]! & 0x0f) << 7) | a[1]!) + 1}`;
    case 0xbf: return `request loco address ${a[1] ? slotAddress(a[2]!, a[1]) : a[2]}`;
    case 0xd0: return `multi sense / transponder ${a.slice(1).map(hex).join(" ")}`;
    case 0xe7:
    case 0xef: {
      // 14 byte slot message: [op, 0x0e, slot, stat, adrLo, spd, dirf, trk, ss2, adrHi, snd, id1, id2, chk]
      if (a.length >= 11) {
        const addr = a[9] ? slotAddress(a[4]!, a[9]!) : a[4]!;
        return `${op === 0xe7 ? "slot data" : "write slot"} ${a[2]}: loco ${addr} speed ${a[5]} status ${hex(a[3]!)}`;
      }
      return "slot data";
    }
  }
  return "";
}

/** Decode one LocoNet message including its trailing checksum byte. */
export function decodeLocoNet(bytes: number[]): LocoNetDecoded {
  const op = bytes[0] ?? 0;
  const checksumOk = bytes.length >= 2 && locoNetChecksum(bytes.slice(0, -1)) === bytes[bytes.length - 1];
  const opcode = NAMES[op] ?? `OPC ${hex(op)}`;
  const text = decodeBody(op, bytes.slice(0, -1)) || `${bytes.length} bytes`;
  return { opcode, text, checksumOk };
}
