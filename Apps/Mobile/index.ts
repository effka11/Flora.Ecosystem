// До expo-router/entry: avatarImageUrl/postImageUrl при eager import табов.
import "react-native-gesture-handler";
import { configureReanimatedLogger, ReanimatedLogLevel } from "react-native-reanimated";
import "./lib/api";
import "expo-router/entry";

/**
 * Strict-режим Reanimated выключен: библиотеки (keyboard-controller, FlashList)
 * читают/пишут SV в рендере, и в dev каждое предупреждение шло через
 * console.warn в Metro — десятки на одно открытие чата, заметная часть
 * стоимости кадра. Свой код SV в рендере не трогает (проверено).
 */
configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false });
