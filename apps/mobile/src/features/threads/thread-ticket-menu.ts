import {
  OPEN_TICKETS_MENU_ID,
  PRIORITY_CLEAR_MENU_ID,
  PRIORITY_MENU_ID,
  PRIORITY_SET_MENU_PREFIX,
  type threadPriorityMenu,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import type { MenuAction } from "@react-native-menu/menu";

/** Shared by the list row menu and the tickets sheet, so both agree on ids and check marks. */
export function buildPriorityMenuAction(menu: ReturnType<typeof threadPriorityMenu>): MenuAction {
  return {
    id: PRIORITY_MENU_ID,
    title: "Priority",
    image: "flag",
    ...(menu.currentLabel ? { subtitle: menu.currentLabel } : {}),
    subactions: [
      ...menu.entries.map(({ ref, checked }): MenuAction => ({
        id: `${PRIORITY_SET_MENU_PREFIX}${ref.id}`,
        title: ref.name,
        state: checked ? "on" : "off",
      })),
      {
        id: PRIORITY_CLEAR_MENU_ID,
        title: "Clear my priority",
        attributes: { disabled: !menu.canClear },
      },
    ],
  };
}

export const OPEN_TICKETS_MENU_ACTION: MenuAction = {
  id: OPEN_TICKETS_MENU_ID,
  title: "Jira tickets…",
  image: "ticket",
};
