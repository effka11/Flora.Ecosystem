import { StyleSheet } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

const DIVIDER = "rgba(250, 250, 250, 0.08)";
const INPUT_BORDER = "rgba(250, 250, 250, 0.15)";

/** Визуальный язык вкладки настроек — паритет с Apps/Web settings.module.css. */
export const settingsUi = StyleSheet.create({
  tabBody: {
    gap: floraSpacing.grid * 2,
    paddingTop: floraSpacing.grid,
  },
  section: {
    gap: floraSpacing.grid * 2,
  },
  sectionTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.54,
    lineHeight: floraSpacing.grid * 2,
    paddingBottom: floraSpacing.grid - 1,
    borderBottomColor: DIVIDER,
    borderBottomWidth: 1,
  },
  fieldsStack: {
    gap: floraSpacing.grid,
  },
  fieldGroup: {
    gap: 0,
  },
  fieldLabel: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.45,
    height: floraSpacing.grid * 2,
    lineHeight: floraSpacing.grid + floraSpacing.gridFine,
    paddingBottom: floraSpacing.gridFine,
    paddingLeft: 2,
    textAlignVertical: "bottom",
    includeFontPadding: false,
  },
  input: {
    backgroundColor: "transparent",
    borderColor: INPUT_BORDER,
    borderWidth: 1,
    borderRadius: 10,
    color: floraColors.whiteTemplate,
    paddingHorizontal: floraSpacing.grid,
    height: floraSpacing.grid * 3,
    fontSize: 15,
    fontWeight: "300",
  },
  feedbackError: {
    color: "#f6a8a8",
    fontSize: 12,
    fontWeight: "300",
    lineHeight: 17,
  },
  feedbackSuccess: {
    color: floraColors.greenLight,
    fontSize: 12,
    fontWeight: "300",
    lineHeight: 17,
  },
  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid * 2,
  },
  avatarActions: {
    flex: 1,
    gap: floraSpacing.gridFine,
    justifyContent: "center",
    minWidth: 0,
  },
  textAction: {
    alignSelf: "flex-start",
    justifyContent: "center",
    minHeight: floraSpacing.grid * 2 + floraSpacing.gridFine * 2,
    paddingVertical: floraSpacing.gridFine,
    paddingHorizontal: 0,
  },
  textActionPrimary: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  textActionMuted: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  textActionDisabled: {
    opacity: 0.4,
  },
  primaryButton: {
    alignSelf: "flex-start",
    minHeight: floraSpacing.grid * 3,
    minWidth: 120,
    paddingHorizontal: floraSpacing.grid * 2,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  primaryButtonText: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  listCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid * 1.5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: DIVIDER,
    backgroundColor: "rgba(250, 250, 250, 0.02)",
    minHeight: floraSpacing.grid * 5,
  },
  listCardInfo: {
    flex: 1,
    gap: floraSpacing.gridFine,
    minWidth: 0,
  },
  listCardTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "400",
    lineHeight: floraSpacing.grid,
  },
  listCardDesc: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    lineHeight: floraSpacing.grid,
  },
  dangerButton: {
    flexShrink: 0,
    minHeight: floraSpacing.grid * 3,
    minWidth: 96,
    paddingHorizontal: floraSpacing.grid * 2,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(246, 168, 168, 0.15)",
  },
  dangerButtonText: {
    color: "#f6a8a8",
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  pressed: {
    opacity: 0.72,
  },
});
