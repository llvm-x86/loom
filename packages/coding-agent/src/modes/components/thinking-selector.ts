import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Renders a reasoning-effort selector (bordered `SelectList`) over the
 * transcript. Accepts configured levels so `auto` and `off` show alongside the
 * model's concrete efforts.
 */
export class ThinkingSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		currentLevel: ConfiguredThinkingLevel,
		availableLevels: ConfiguredThinkingLevel[],
		onSelect: (level: ConfiguredThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map(getConfiguredThinkingLevelMetadata);

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex(item => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as ConfiguredThinkingLevel);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
