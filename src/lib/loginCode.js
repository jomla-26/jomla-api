import crypto from "node:crypto";
import { hashOtp } from "./helpers.js";

// رمز دخول مؤقت (6 أرقام) يُعطى لصاحب الحساب من الإدارة عند فتح حسابه — بدل رسالة SMS (توفير + أبسط).
// يُستعمل مرة واحدة، وبعده يُطلب من صاحب الحساب كلمة مرور. صالح 7 أيام، ويقدر المدير يصدر رمز جديد في أي وقت.
export async function setInitialLoginCode(client, table, id, days = 7) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await client.query(
    `UPDATE ${table} SET temp_code_hash = $2, temp_code_expires_at = now() + ($3 || ' days')::interval,
            failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [id, await hashOtp(code), String(days)]
  );
  return code;
}
