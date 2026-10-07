// إرسال الرسائل النصية (SMS) لرموز الدخول. المزوّد يتحدد بمتغير SMS_PROVIDER: twilio | infobip
// المتغيرات المطلوبة:
//   twilio : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  (رقم أو اسم مرسل)
//   infobip: INFOBIP_BASE_URL (مثل xxxx.api.infobip.com), INFOBIP_API_KEY, INFOBIP_FROM
// مفتاح أمان: الإرسال الفعلي مقفول افتراضيًا (يوفر الرصيد أثناء التجربة). يُفتح بإضافة SMS_ENABLED=1 في Railway.
export const smsEnabled = () => process.env.SMS_ENABLED === "1";

export function smsConfigured() {
  const p = process.env.SMS_PROVIDER;
  if (p === "twilio") return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  if (p === "infobip") return Boolean(process.env.INFOBIP_BASE_URL && process.env.INFOBIP_API_KEY && process.env.INFOBIP_FROM);
  return false;
}

export function toInternational(rawPhone) {
  let p = String(rawPhone).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "218" + p.slice(1);
  if (!p.startsWith("218")) p = "218" + p;
  return p;
}

export async function sendSms(phone, text) {
  if (!smsEnabled()) throw new Error("SMS مقفول (SMS_ENABLED غير مفعّل)");
  const to = toInternational(phone);
  const provider = process.env.SMS_PROVIDER;
  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: "+" + to, From: process.env.TWILIO_FROM, Body: text }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || ""}`);
    return;
  }
  if (provider === "infobip") {
    const base = process.env.INFOBIP_BASE_URL.replace(/^https?:\/\//, "");
    const r = await fetch(`https://${base}/sms/2/text/advanced`, {
      method: "POST",
      headers: { Authorization: `App ${process.env.INFOBIP_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ messages: [{ from: process.env.INFOBIP_FROM, destinations: [{ to }], text }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Infobip ${r.status}: ${j.requestError?.serviceException?.text || ""}`);
    return;
  }
  throw new Error("مزوّد الرسائل النصية غير مضبوط");
}
