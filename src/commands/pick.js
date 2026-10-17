// A small helper the commands share: pick one value from a short list with the menu used by the permission dialog.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";

/**
 * options: [{ value, label, hint? }]. Resolves the chosen value, or undefined when the person backed out (Esc) or
 * when there is no menu to show (no terminal).
 */
export async function chooseOption(ctx, { title, options, current }) {
  if (typeof ctx.ui.pick !== "function") return undefined;
  const items = options.map(option => ({ label: option.value === current ? `${option.label}  ${t("app.pick.current")}` : option.label, hint: option.hint }));
  const initial = Math.max(0, options.findIndex(option => option.value === current));
  const index = await ctx.ui.pick({ title, items, initial });
  return index >= 0 ? options[index].value : undefined;
}
