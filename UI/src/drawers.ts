import type { ComponentType } from "react";
export interface DrawerProps { id: string }
export const DRAWERS: Record<string, ComponentType<DrawerProps>> = {};
export function registerDrawer(key: string, C: ComponentType<DrawerProps>) { DRAWERS[key] = C; }
