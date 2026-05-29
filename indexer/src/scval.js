import { xdr, StrKey } from "@stellar/stellar-sdk";

/**
 * Convert any ScVal XDR object to a native JavaScript value.
 * Uses BigInt for i64/u64/i128/u128 to prevent precision loss.
 *
 * @param {xdr.ScVal} val
 * @returns {*} native JS primitive, object, or array
 */
export function scValToJs(val) {
  if (!val) return null;

  const type = val.switch().name;

  switch (type) {
    case "scvBool":
      return val.b();

    case "scvVoid":
      return null;

    case "scvError":
      return { error: val.error().toString() };

    case "scvU32":
      return val.u32();

    case "scvI32":
      return val.i32();

    case "scvU64":
      return BigInt(val.u64().toString());

    case "scvI64":
      return BigInt(val.i64().toString());

    case "scvTimepoint":
      return BigInt(val.timepoint().toString());

    case "scvDuration":
      return BigInt(val.duration().toString());

    case "scvU128": {
      const u = val.u128();
      return (BigInt(u.hi().toString()) << 64n) | BigInt(u.lo().toString());
    }

    case "scvI128": {
      const i = val.i128();
      return (BigInt(i.hi().toString()) << 64n) | BigInt(i.lo().toString());
    }

    case "scvU256": {
      const u = val.u256();
      return (
        (BigInt(u.hiHi().toString()) << 192n) |
        (BigInt(u.hiLo().toString()) << 128n) |
        (BigInt(u.loHi().toString()) << 64n) |
        BigInt(u.loLo().toString())
      );
    }

    case "scvI256": {
      const i = val.i256();
      return (
        (BigInt(i.hiHi().toString()) << 192n) |
        (BigInt(i.hiLo().toString()) << 128n) |
        (BigInt(i.loHi().toString()) << 64n) |
        BigInt(i.loLo().toString())
      );
    }

    case "scvBytes":
      return Buffer.from(val.bytes()).toString("hex");

    case "scvString":
      return val.str().toString();

    case "scvSymbol":
      return val.sym().toString();

    case "scvVec":
      return (val.vec() ?? []).map(scValToJs);

    case "scvMap": {
      const obj = {};
      for (const entry of val.map() ?? []) {
        const k = scValToJs(entry.key());
        obj[String(k)] = scValToJs(entry.val());
      }
      return obj;
    }

    case "scvAddress": {
      const addr = val.address();
      const addrType = addr.switch().name;
      if (addrType === "scAddressTypeAccount") {
        return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
      }
      if (addrType === "scAddressTypeContract") {
        return StrKey.encodeContract(addr.contractId());
      }
      return addr.toString();
    }

    case "scvLedgerKeyContractInstance":
      return { type: "ledgerKeyContractInstance" };

    case "scvLedgerKeyNonce":
      return { type: "ledgerKeyNonce", nonce: BigInt(val.nonceKey().nonce().toString()) };

    case "scvContractInstance":
      return { type: "contractInstance" };

    default:
      return String(val);
  }
}
