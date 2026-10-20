// Every message the service link can show a person. The service's own error text is English and is
// never displayed: the link maps an error CODE to one of these, each with a "what to do next" hint.
// Keys are the codes (see errors.js for the aliases that share a message); "generic" is the fallback
// for a code nobody mapped, and "generic_plain" is the same without an HTTP status.
import { registerStrings } from "../i18n/index.js";

const ar = {
  "err.access_missing": "لا يوجد رمز دخول بعد. الصق رمز الدخول الذي لديك للمتابعة.",
  "err.access_invalid": "رمز الدخول غير صحيح. تأكد أنك نسخته كاملاً، أو اطلب رمزاً جديداً.",
  "err.access_expired": "انتهت صلاحية رمز الدخول. اطلب رمزاً جديداً ثم أدخله من جديد.",
  "err.access_denied": "رمز الدخول هذا غير مفعل بعد. اطلب تفعيله أو احصل على رمز جديد.",
  "err.daily_limit": "وصلت إلى حد الاستخدام اليومي. يتجدد الحد غداً، فعد حينها.",
  "err.busy": "الخدمة مشغولة الآن. أعد المحاولة بعد لحظات.",
  "err.request_too_large": "المحادثة أطول من أن ترسل في طلب واحد. اكتب /compact لتلخيصها ثم أعد المحاولة.",
  "err.unavailable": "الخدمة غير متاحة مؤقتا. حاول مرة أخرى بعد قليل.",
  "err.not_configured": "الخدمة غير جاهزة بعد. حاول لاحقا، وإن استمر الأمر فأخبر فراس.",
  "err.request_rejected": "رفضت الخدمة هذا الطلب. حدث التطبيق بالأمر /update ثم أعد المحاولة.",
  "err.invalid_request": "تعذرت قراءة الطلب. جرب /compact، أو ابدأ محادثة جديدة بالأمر /clear.",
  "err.upstream_refused": "لم تقبل الخدمة هذا الطلب. جرب تبسيطه، أو ابدأ محادثة جديدة بالأمر /clear.",
  "err.client_required": "الخدمة لم تتعرف على إصدار التطبيق. حدثه بالأمر /update ثم أعد المحاولة.",
  "err.network_dns": "تعذر الوصول إلى الخدمة، فلم يعثر على عنوانها. تحقق من اتصالك بالإنترنت.",
  "err.network_refused": "رفض الخادم الاتصال. أعد المحاولة بعد قليل.",
  "err.network_timeout": "انتهت مهلة الاتصال بالخدمة. تحقق من الإنترنت ثم أعد المحاولة.",
  "err.network_reset": "انقطع الاتصال بالخدمة فجأة. أعد المحاولة.",
  "err.network_offline": "لا يوجد اتصال بالإنترنت. تحقق من الشبكة ثم أعد المحاولة.",
  "err.network_tls": "تعذر إنشاء اتصال آمن بالخدمة. تحقق من تاريخ الجهاز ووقته، أو من برنامج الحماية وإعدادات الشبكة.",
  "err.network": "حدثت مشكلة في الاتصال بالخدمة. تحقق من الإنترنت ثم أعد المحاولة.",
  "err.stream_idle": "توقفت الخدمة عن الإرسال لفترة طويلة، فأغلق الاتصال. أعد المحاولة.",
  "err.stream_broken": "انقطع الرد قبل أن يكتمل. أعد المحاولة.",
  "err.bad_response": "وصل من الخدمة رد غير مفهوم. أعد المحاولة بعد قليل.",
  "err.bad_origin": "عنوان الخدمة غير صالح. استخدم عنوانا يبدأ بـ https.",
  "err.generic": "تعذر إكمال الطلب (الرمز {status}). أعد المحاولة بعد قليل.",
  "err.generic_plain": "تعذر إكمال الطلب. أعد المحاولة بعد قليل.",
};

const en = {
  "err.access_missing": "There is no access code yet. Paste your access code to continue.",
  "err.access_invalid": "That access code isn't valid. Check that you copied all of it, or ask for a new one.",
  "err.access_expired": "Your access code has expired. Ask for a new one, then enter it again.",
  "err.access_denied": "This access code isn't active yet. Ask for it to be enabled, or get a new one.",
  "err.daily_limit": "You've reached today's usage limit. It resets tomorrow, so come back then.",
  "err.busy": "The service is busy right now. Try again in a moment.",
  "err.request_too_large": "This conversation is too large for one request. Type /compact to summarize it, then try again.",
  "err.unavailable": "The service is temporarily unavailable. Please try again shortly.",
  "err.not_configured": "The service isn't ready yet. Try again later, and if it keeps happening let Firas know.",
  "err.request_rejected": "The service rejected this request. Update the app with /update and try again.",
  "err.invalid_request": "The request couldn't be read. Try /compact, or start a new conversation with /clear.",
  "err.upstream_refused": "The service didn't accept this request. Try simplifying it, or start a new conversation with /clear.",
  "err.client_required": "The service didn't recognize this version of the app. Update it with /update and try again.",
  "err.network_dns": "Couldn't reach the service: its address wasn't found. Check your internet connection.",
  "err.network_refused": "The server refused the connection. Try again in a little while.",
  "err.network_timeout": "The connection to the service timed out. Check your internet and try again.",
  "err.network_reset": "The connection to the service dropped suddenly. Try again.",
  "err.network_offline": "There is no internet connection. Check your network and try again.",
  "err.network_tls": "Couldn't set up a secure connection to the service. Check the device's date and time, or your security software and network settings.",
  "err.network": "There was a problem connecting to the service. Check your internet and try again.",
  "err.stream_idle": "The service stopped sending for too long, so the connection was closed. Try again.",
  "err.stream_broken": "The reply was cut off before it finished. Try again.",
  "err.bad_response": "The service sent a reply that couldn't be understood. Try again shortly.",
  "err.bad_origin": "The service address isn't valid. Use an address that starts with https.",
  "err.generic": "The request couldn't be completed (code {status}). Please try again shortly.",
  "err.generic_plain": "The request couldn't be completed. Please try again shortly.",
};

registerStrings("link", { ar, en });

/** Message keys (without the "err." prefix) that exist in the table. */
export const LINK_MESSAGE_KEYS = Object.freeze(Object.keys(en).map(key => key.slice(4)));
