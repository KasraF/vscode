/* import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
 */

import 'vs/css!./rtv';
import { ICursorPositionChangedEvent } from 'vs/editor/common/controller/cursorEvents';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { IEditorContribution, IScrollEvent } from 'vs/editor/common/editorCommon';
import {
	EditorAction,
	registerEditorAction,
	registerEditorContribution,
	ServicesAccessor
} from 'vs/editor/browser/editorExtensions';
import { EditorLayoutInfo, EditorOption } from 'vs/editor/common/config/editorOptions';
import * as strings from 'vs/base/common/strings';
import { IRange, Range } from 'vs/editor/common/core/range';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IModeService } from 'vs/editor/common/services/modeService';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { MarkdownRenderer } from 'vs/editor/contrib/markdown/markdownRenderer';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { IConfigurationChangeEvent, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Registry } from 'vs/platform/registry/common/platform';
import { Extensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { localize } from 'vs/nls';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Action, IAction } from 'vs/base/common/actions';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { ContextSubMenu } from 'vs/base/browser/contextmenu';
import { IMouseWheelEvent } from 'vs/base/browser/mouseEvent';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import {
	badgeBackground,
	editorWidgetBackground,
	inputBackground,
	inputBorder,
	inputForeground,
	widgetShadow
} from 'vs/platform/theme/common/colorRegistry';
import { IIdentifiedSingleEditOperation, IModelDecorationOptions, ITextModel } from 'vs/editor/common/model';
import { Selection } from 'vs/editor/common/core/selection';
import { RTVLogger } from 'vs/editor/contrib/rtv/RTVLogger';
import * as utils from 'vs/editor/contrib/rtv/RTVUtils';

function indent(s: string): number {
	return s.length - s.trimLeft().length;
}

function isHtmlEscape(s: string): boolean {
	return strings.startsWith(s, '```html\n') && strings.endsWith(s, '```');
}

function removeHtmlEscape(s: string): string {
	let x = '```html\n'.length;
	let y = '```'.length;
	return s.substring(x, s.length - y);
}

function arrayStartsWith<T>(haystack: T[], needle: T[]): boolean {
	if (haystack.length < needle.length) {
		return false;
	}

	if (haystack === needle) {
		return true;
	}

	for (let i = 0; i < needle.length; i++) {
		if (haystack[i] !== needle[i]) {
			return false;
		}
	}

	return true;
}

function isEmpty(str: string) {
	return str.trim() === '';
}

function isSeedLine(str: string) {
	return str.match('#@') !== null;
}

function isLoopStr(str: string) {
	let trimmed = str.trim();
	return strings.endsWith(trimmed, ':') &&
		(strings.startsWith(trimmed, 'for') ||
			strings.startsWith(trimmed, 'while'));
}

function strNumsToArray(s: string): number[] {
	if (s === '') {
		return [];
	} else {
		return s.split(',').map(e => +e);
	}
}

// returns true if s matches regExp
function regExpMatchEntireString(s: string, regExp: string) {
	let res = s.match(regExp);
	return res !== null && res.index === 0 && res[0] === s;
}

class DelayedRunAtMostOne {
	private _timer: ReturnType<typeof setTimeout> | null = null;

	public run(delay: number, c: () => void) {
		if (this._timer !== null) {
			clearTimeout(this._timer);
		}
		if (delay === 0) {
			this._timer = null;
			c();
		} else {
			this._timer = setTimeout(() => {
				this._timer = null;
				c();
			}, delay);
		}
	}
}

class DeltaVarSet {
	private _plus: Set<string>;
	private _minus: Set<string>;
	constructor(other?: DeltaVarSet) {
		if (other === undefined) {
			this._plus = new Set();
			this._minus = new Set();
		} else {
			this._plus = new Set(other._plus);
			this._minus = new Set(other._minus);
		}
	}
	public add(v: string) {
		if (this._minus.has(v)) {
			this._minus.delete(v);
		} else {
			this._plus.add(v);
		}
	}
	public delete(v: string) {
		if (this._plus.has(v)) {
			this._plus.delete(v);
		} else {
			this._minus.add(v);
		}
	}
	public applyTo(s: Set<string>, all: Set<string>) {
		let res = new Set<string>(s);
		this._plus.forEach(v => {
			if (all.has(v)) {
				if (res.has(v)) {
					//this._plus.delete(v);
				} else {
					res.add(v);
				}
			} else {
				//this._plus.delete(v);
			}
		});
		this._minus.forEach(v => {
			if (all.has(v)) {
				if (res.has(v)) {
					res.delete(v);
				} else {
					//this._minus.delete(v);
				}
			} else {
				//this._minus.delete(v);
			}
		});
		return res;
	}
	public clear() {
		this._plus.clear();
		this._minus.clear();
	}
}

class RTVLine {
	private _div: HTMLDivElement;
	constructor(
		editor: ICodeEditor,
		x1: number,
		y1: number,
		x2: number,
		y2: number
	) {
		let editor_div = editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}

		this._div = document.createElement('div');
		this._div.style.position = 'absolute';
		this._div.style.borderTop = '1px solid grey';
		this._div.style.transitionProperty = 'all';
		this._div.style.transitionDuration = '0.3s';
		this._div.style.transitionDelay = '0s';
		this._div.style.transitionTimingFunction = 'ease-in';
		this._div.style.transformOrigin = '0% 0%';
		this.move(x1, y1, x2, y2);
		editor_div.appendChild(this._div);
	}

	public destroy() {
		this._div.remove();
	}

	public move(x1: number, y1: number, x2: number, y2: number) {
		this._div.style.left = x1.toString() + 'px';
		this._div.style.top = y1.toString() + 'px';
		let deltaX = (x2 - x1);
		let deltaY = (y2 - y1);
		let length = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
		this._div.style.width = length.toString() + 'px';
		let angle = 0;
		if (length !== 0) {
			angle = Math.atan(deltaY / deltaX) * 180 / Math.PI;
		}
		this._div.style.transform = 'rotate(' + angle.toString() + 'deg)';
	}

	public setOpacity(opacity: number) {
		this._div.style.opacity = opacity.toString();
	}

}

class TableElement {
	constructor(
		public content: string,
		public loopID: string,
		public iter: string,
		public controllingLineNumber: number,
		public vname?: string,
		public env?: any
	) { }
}

type MapLoopsToCells = { [k: string]: HTMLTableDataCellElement[]; };

class RTVDisplayBox {
	private _box: HTMLDivElement;
	private _line: RTVLine;
	private _zoom: number = 1;
	private _opacity: number = 1;
	private _hasContent: boolean = false;
	private _allEnvs: any[] = [];
	private _allVars: Set<string> = new Set<string>();
	private _displayedVars: Set<string> = new Set<string>();
	private _deltaVarSet: DeltaVarSet;
	private _cellDictionary: { [k: string]: [HTMLElement] } = {};
	private _timesToInclude: Set<number> = new Set<number>();

	constructor(
		private readonly _controller: RTVController,
		private readonly _editor: ICodeEditor,
		private readonly _modeService: IModeService,
		private readonly _openerService: IOpenerService,
		public lineNumber: number,
		deltaVarSet: DeltaVarSet
	) {
		// if (this._controller.displayOnlyModifiedVars) {
		// 	this._displayedVars = new ModVarSet(this);
		// } else {
		// 	this._displayedVars = new FullVarSet(this);
		// }
		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}
		this._box = document.createElement('div');
		this._box.textContent = '';
		this._box.style.position = 'absolute';
		this._box.style.top = '100px';
		this._box.style.left = '800px';
		this._box.style.maxWidth = '1366px';
		this._box.style.transitionProperty = 'all';
		this._box.style.transitionDuration = '0.3s';
		this._box.style.transitionDelay = '0s';
		this._box.style.transitionTimingFunction = 'ease-in';
		this._box.className = 'monaco-hover';
		if (!this._controller.supportSynthesis) {
			this._box.onauxclick = (e) => {
				this.onClick(e);
			};
			this._box.onclick = (e) => {
				this.onClick(e);
			};
		}
		editor_div.appendChild(this._box);
		this._line = new RTVLine(this._editor, 800, 100, 800, 100);
		this.setContentFalse();
		this._deltaVarSet = new DeltaVarSet(deltaVarSet);
	}

	get visible() {
		return this._hasContent;
	}

	public getCellContent() {

		return this._cellDictionary;
	}

	public hasContent() {
		return this._hasContent;
	}

	public destroy() {
		this._box.remove();
		this._line.destroy();
	}

	public setContentFalse() {
		// Set content to false. Boxes with no content don't get processed during layout pass,
		// so we take care of layout here, which is to make  invisible (opacity 0).
		this._allEnvs = [];
		this._hasContent = false;
		this._box.textContent = '';
		this._box.style.opacity = '0';
		this._line.setOpacity(0);
	}

	public setContentTrue() {
		// Set content to true. All other layout properties will be set during
		// layout pass
		this._hasContent = true;
	}

	public modVars() {
		let writesAtLine = this._controller.writes[this.lineNumber - 1];
		if (writesAtLine === undefined) {
			writesAtLine = [];
		}
		let result = new Set<string>(writesAtLine);
		if (this._allVars.has('rv')) {
			result.add('rv');
		}
		return result;
	}

	public allVars() {
		return this._allVars;
	}

	public notDisplayedVars() {
		let result = new Set<string>();
		let displayed = this._displayedVars;
		this._allVars.forEach((v: string) => {
			if (!displayed.has(v)) {
				result.add(v);
			}
		});
		return result;
	}

	public getLineContent(): string {
		return this._controller.getLineContent(this.lineNumber);
	}

	public getLoopID(): string {
		if (this._allEnvs.length === 0) {
			return '';
		}
		return this._allEnvs[0]['$'];
	}

	public getFirstLoopIter(): string {
		if (this._allEnvs.length === 0) {
			return '';
		}
		return this._allEnvs[0]['#'];
	}

	public getNextLoopIter(loopID: string, iter: string, delta: number): string {
		if (delta === 0) {
			return iter;
		}

		let first = '';
		let envs = this._allEnvs;
		if (delta < 0) {
			envs = envs.slice(0, envs.length).reverse();
		}

		for (let i = 0; i < envs.length; i++) {
			let env = envs[i];

			if (env['$'] !== loopID) {
				throw Error('Error');
			}
			if (first === '') {
				if (env['$'] === loopID) {
					first = env['#'];
				}
			}

			if (env['$'] === loopID && env['#'] === iter) {
				let nexti = i + 1;
				if (nexti >= envs.length) {
					return first;
				}
				let nextEnv = envs[nexti];
				if (nextEnv['$'] !== loopID) {
					throw Error('Error');
				}
				if (nextEnv['$'] === loopID) {
					return nextEnv['#'];
				} else {
					return first;
				}
			}
		}

		return first;
	}

	private onClick(e: MouseEvent) {
		let c = this._controller;
		let currViewMode = c.viewMode;

		let viewModes = [ViewMode.Full, ViewMode.CursorAndReturn, ViewMode.Compact, ViewMode.Stealth];
		let viewModeActions = viewModes.map((v) => {
			let action = this.newAction(v, () => {
				c.changeViewMode(v);
			});
			if (currViewMode === v) {
				action.checked = true;
			}
			return action;
		});

		c.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => [
				this.newAction('Hide This Box', () => {
					c.hideBox(this);
				}),
				this.newAction('Hide All Other Boxes', () => {
					c.hideAllOtherBoxes(this);
				}),
				new Separator(),
				this.newAction('Restore This Box to Default', () => {
					c.restoreBoxToDefault(this);
				}),
				this.newAction('Restore All Boxes to Default', () => {
					c.restoreAllBoxesToDefault();
				}),
				new Separator(),
				new ContextSubMenu('Appearance of All Boxes', viewModeActions),
				new Separator(),
				this.newAction('See All Loop Iterations', () => {
					c.loopFocusController = null;
				}),
			],
			onHide: () => { },
			autoSelectFirstItem: true
		});
	}

	private isConditionalLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return strings.endsWith(lineContent, ':') &&
			(strings.startsWith(lineContent, 'if') ||
				strings.startsWith(lineContent, 'else'));
	}

	private isLoopLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return strings.endsWith(lineContent, ':') &&
			(strings.startsWith(lineContent, 'for') ||
				strings.startsWith(lineContent, 'while'));
	}

	public isBreakLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return strings.startsWith(lineContent, 'break');
	}

	public isReturnLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return strings.startsWith(lineContent, 'return');
	}

	private bringToLoopCount(envs: any[], active_loop_iters: number[], loopId: string, iterCount: number) {
		while (active_loop_iters[active_loop_iters.length - 1] < iterCount) {
			envs.push({ '#': active_loop_iters.join(','), '$': loopId });
			active_loop_iters[active_loop_iters.length - 1]++;
		}
	}

	private addMissingLines(envs: any[]): any[] {
		let last = function <T>(a: T[]): T { return a[a.length - 1]; };
		let active_loop_iters: number[] = [];
		let active_loop_ids: string[] = [];
		let envs2: any[] = [];
		for (let i = 0; i < envs.length; i++) {
			let env = envs[i];
			if (env.begin_loop !== undefined) {
				if (active_loop_iters.length > 0) {
					let loop_iters: string[] = env.begin_loop.split(',');
					this.bringToLoopCount(envs2, active_loop_iters, last(active_loop_ids), +loop_iters[loop_iters.length - 2]);
				}
				active_loop_ids.push(env['$']);
				active_loop_iters.push(0);
			} else if (env.end_loop !== undefined) {
				let loop_iters: string[] = env.end_loop.split(',');
				this.bringToLoopCount(envs2, active_loop_iters, last(active_loop_ids), +last(loop_iters));
				active_loop_ids.pop();
				active_loop_iters.pop();
				active_loop_iters[active_loop_iters.length - 1]++;
			} else {
				let loop_iters: string[] = env['#'].split(',');
				this.bringToLoopCount(envs2, active_loop_iters, last(active_loop_ids), +last(loop_iters));
				envs2.push(env);
				active_loop_iters[active_loop_iters.length - 1]++;
			}
		}
		return envs2;
	}

	private adjustToNextTimeStep(envs: any[]): any[] {
		if (this.isBreakLine()) {
			return envs;
		}
		let envs2: any[] = [];
		let isLoop = this.isLoopLine();
		let currIndent = this.indentAtLine(this.lineNumber);
		envs.forEach((env) => {
			if (env.begin_loop !== undefined) {
				envs2.push(env);
			} else if (env.end_loop !== undefined) {
				envs2.push(env);
			} else if (env.next_lineno !== undefined) {
				if (!isLoop || this.indentAtLine(env.next_lineno + 1) > currIndent) {
					let nextEnv = this._controller.getEnvAtNextTimeStep(env);
					if (nextEnv !== null) {
						envs2.push(nextEnv);
					}
				}
			}
		});
		return envs2;
	}

	private filterLoops(envs: any[]): any[] {
		if (this._controller.loopFocusController === null) {
			return envs;
		}

		let focusCtrl = this._controller.loopFocusController;

		return envs.filter((e, i, a) => focusCtrl.matches(e['$'], e['#']));
	}

	private findParentRow(cell: HTMLElement): HTMLTableRowElement {
		let rs = cell;
		while (rs.nodeName !== 'TR') {
			rs = rs.parentElement!;
		}
		return rs as HTMLTableRowElement;
	}

	private synthToggleElement(elmt: TableElement, cell: HTMLElement, force: boolean | null = null) {
		let time = elmt.env['time'];
		let row = this.findParentRow(cell);
		let on: boolean;

		if (force !== null) {
			on = force;
		} else {
			on = !this._timesToInclude.has(time);
		}

		if (on) {
			// Toggle on
			elmt.env[elmt.vname!] = cell.innerText;
			this._timesToInclude.add(time);

			// Highligh the row
			let theme = this._controller._themeService.getColorTheme();
			row.style.fontWeight = '900';
			row.style.backgroundColor = String(theme.getColor(badgeBackground) ?? '');

			this._controller.logger.exampleInclude(this.findParentRow(cell).rowIndex, cell.innerText);
		} else {
			// Toggle off
			this._timesToInclude.delete(time);

			// Remove row highlight
			row.style.fontWeight = row.style.backgroundColor = '';

			this._controller.logger.exampleExclude(this.findParentRow(cell).rowIndex, cell.innerText);
		}
	}

	private synthFocusNextRow(backwards: boolean = false): void {
		let selection = window.getSelection()!;
		let cell: HTMLTableCellElement;
		let row: HTMLTableRowElement;

		for (let cellIter = selection.focusNode!; cellIter.parentNode; cellIter = cellIter.parentNode) {
			if (cellIter.nodeName === 'TD') {
				cell = cellIter as HTMLTableCellElement;
				break;
			}
		}

		for (let rowIter = cell!.parentNode!; rowIter.parentNode; rowIter = rowIter.parentNode) {
			if (rowIter.nodeName === 'TR') {
				row = rowIter as HTMLTableRowElement;
				break;
			}
		}

		this._controller.logger.exampleBlur(row!.rowIndex, cell!.textContent!);

		if (this._controller.byRowOrCol === RowColMode.ByCol) {
			let table: HTMLTableElement = row!.parentNode as HTMLTableElement;
			let nextRowIdx = (row!.rowIndex - 1 + (backwards ? -1 : 1)) % (table.rows.length - 1) + 1;
			if (nextRowIdx <= 0) { nextRowIdx += table.rows.length - 1; }
			let nextRow = table.rows[nextRowIdx];
			let col = nextRow.childNodes[cell!.cellIndex!];
			let newFocusNode = col.childNodes[0];
			let range = selection?.getRangeAt(0);
			range.selectNodeContents(newFocusNode);
			selection?.removeAllRanges();
			selection?.addRange(range);
			this._controller.logger.exampleFocus(nextRowIdx, newFocusNode!.textContent!);
		} else {
			let nextCellIdx = (cell!.cellIndex - 1 + (backwards ? -1 : 1)) % (row!.childNodes.length - 1) + 1;
			if (nextCellIdx <= 0) { nextCellIdx += row!.childNodes.length - 1; }
			let col = row!.childNodes[nextCellIdx];
			let newFocusNode = col.childNodes[0];
			let range = selection?.getRangeAt(0);
			range.selectNodeContents(newFocusNode);
			selection?.removeAllRanges();
			selection?.addRange(range);
			this._controller.logger.exampleFocus(nextCellIdx, newFocusNode!.textContent!);
		}
	}

	private addCellContentAndStyle(cell: HTMLTableCellElement, elmt: TableElement, r: MarkdownRenderer) {
		if (this._controller.colBorder) {
			cell.style.borderLeft = '1px solid #454545';
		}
		let padding = this._controller.cellPadding + 'px';
		cell.style.paddingLeft = padding;
		cell.style.paddingRight = padding;
		cell.style.paddingTop = '0';
		cell.style.paddingBottom = '0';

		cell.align = 'center';

		/* if (this._controller.byRowOrCol === RowColMode.ByCol) {
			cell.align = 'center';
		} else {
			cell.align = 'center';
		} */

		let s = elmt.content;
		let cellContent: HTMLElement;
		if (s === '') {
			// Make empty strings into a space to make sure it's allocated a space
			// Otherwise, the divs in a row could become invisible if they are
			// all empty
			cellContent = document.createElement('div');
			cellContent.innerHTML = '&nbsp';
		}
		else if (isHtmlEscape(s)) {
			cellContent = document.createElement('div');
			cellContent.innerHTML = removeHtmlEscape(s);
		} else {
			let renderedText = r.render(new MarkdownString(s));
			cellContent = renderedText.element;

			if (this._controller.supportSynthesis) {
				cellContent.onblur = (e: FocusEvent) => {
					if (elmt.env[elmt.vname!] !== cellContent.innerText) {
						// TODO This might be expensive
						this._controller.logger.exampleChanged(
							this.findParentRow(cell).rowIndex,
							elmt.env[elmt.vname!],
							cellContent.innerText);
						this.synthToggleElement(elmt, cellContent, true);
					}
				};

				cellContent.onkeydown = (e: KeyboardEvent) => {
					let rs: boolean = true;

					switch (e.key) {
						case 'Enter':
							e.preventDefault();

							if (e.shiftKey) {
								this.synthToggleElement(elmt, cellContent);
								this.synthFocusNextRow();
							} else {
								if (elmt.env[elmt.vname!] !== cellContent.innerText) {
									this._controller.logger.exampleChanged(
										this.findParentRow(cell).rowIndex,
										elmt.env[elmt.vname!],
										cellContent.innerText);
									this.synthToggleElement(elmt, cellContent, true);
								}
								cellContent.contentEditable = 'false';
								this._editor.focus();
								this._controller.logger.projectionBoxExit();
								setTimeout(() => {
									// Pressing enter also triggers the blur event, so we don't need to record any changes here.
									this._controller.synthesizeFragment(elmt.controllingLineNumber, this._timesToInclude);
									this._timesToInclude.clear();
									this._controller.logger.exampleReset();
								}, 200);
							}
							break;
						case 'Tab':
							// ----------------------------------------------------------
							// Use Tabs to go over values of the same variable
							// ----------------------------------------------------------
							e.preventDefault();
							this.synthFocusNextRow(e.shiftKey);
							break;
						case 'Escape':
							this._controller.logger.projectionBoxExit();
							this._editor.focus();
							this._controller.runProgram();
							this._timesToInclude.clear();
							this._controller.logger.exampleReset();
							rs = false;
							break;
					}

					return rs;
				};
			}
		}
		if (this._controller.mouseShortcuts) {
			if (elmt.iter === 'header') {
				cellContent = this.wrapAsVarMenuButton(cellContent, s.substr(2, s.length - 4));
			} else if (elmt.iter !== '') {
				cellContent = this.wrapAsLoopMenuButton(cellContent, elmt.iter);
			}
		}

		if (this.lineNumber === elmt.controllingLineNumber) {
			let name = elmt.vname!;
			if (name) {
				if (name in this._cellDictionary) {
					this._cellDictionary[name].push(cellContent);
				} else {
					this._cellDictionary[name] = [cellContent];
				}
			}
		}

		cell.appendChild(cellContent);
	}

	private populateTableByCols(table: HTMLTableElement, renderer: MarkdownRenderer, rows: TableElement[][]) {
		rows.forEach((row: TableElement[]) => {
			let newRow = table.insertRow(-1);
			row.forEach((elmt: TableElement) => {
				let newCell = newRow.insertCell(-1);
				this.addCellContentAndStyle(newCell, elmt, renderer);
			});
		});
	}

	private populateTableByRows(table: HTMLTableElement, renderer: MarkdownRenderer, rows: TableElement[][]) {
		let tableCellsByLoop = this._controller.tableCellsByLoop;
		for (let colIdx = 0; colIdx < rows[0].length; colIdx++) {
			let newRow = table.insertRow(-1);
			for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
				let elmt = rows[rowIdx][colIdx];
				let newCell = newRow.insertCell(-1);
				this.addCellContentAndStyle(newCell, elmt, renderer);
				if (elmt.iter !== '') {
					if (tableCellsByLoop[elmt.iter] === undefined) {
						tableCellsByLoop[elmt.iter] = [];
					}
					tableCellsByLoop[elmt.iter].push(newCell);
				}
			}
		}
	}

	// private createTableByRows2(rows: TableElement[][]) {
	// 	this._box.textContent = '';
	// 	let tableCellsByLoop = this._coordinator.tableCellsByLoop;
	// 	const renderer = new MarkdownRenderer(this._editor, this._modeService, this._openerService);
	// 	let table = document.createElement('div');
	// 	table.style.display = 'table';
	// 	for (let colIdx = 0; colIdx < rows[0].length; colIdx++) {
	// 		let newRow = document.createElement('div');
	// 		newRow.style.display = 'table-row';
	// 		table.appendChild(newRow);
	// 		for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
	// 			let elmt = rows[rowIdx][colIdx];
	// 			let newCell = this.computeCellContent(elmt.content, renderer)
	// 			newCell.style.display = 'table-cell';
	// 			newCell.style.width = '120px';
	// 			newRow.appendChild(newCell);
	// 		}
	// 	}
	// 	this._box.appendChild(table);
	// }

	public indentAtLine(lineno: number): number {
		return indent(this._controller.getLineContent(lineno));
	}

	public computeEnvs() {

		if (!this._controller.showBoxAtLoopStmt && this.isLoopLine()) {
			this.setContentFalse();
			return;
		}

		if (this.isConditionalLine()) {
			this.setContentFalse();
			return;
		}

		// Get all envs at this line number
		let envs = this._controller.envs[this.lineNumber - 1];
		if (envs === undefined) {
			this.setContentFalse();
			return;
		}

		this.setContentTrue();

		envs = this.adjustToNextTimeStep(envs);
		envs = this.addMissingLines(envs);

		this._allEnvs = envs;

	}

	public updateContent() {

		if (!this._controller.showBoxAtLoopStmt && this.isLoopLine()) {
			this.setContentFalse();
			return;
		}

		if (this.isConditionalLine()) {
			this.setContentFalse();
			return;
		}

		// Get all envs at this line number
		let envs = this._controller.envs[this.lineNumber - 1];
		if (envs === undefined) {
			this.setContentFalse();
			return;
		}

		this.setContentTrue();

		envs = this.adjustToNextTimeStep(envs);
		envs = this.addMissingLines(envs);

		this._allEnvs = envs;

		// Compute set of vars in all envs
		this._allVars = new Set<string>();
		envs.forEach((env) => {
			for (let key in env) {
				if (key !== 'prev_lineno' && key !== 'next_lineno' && key !== 'lineno' && key !== 'time' && key !== '$') {
					this._allVars.add(key);
				}
			}
		});

		let startingVars: Set<string>;
		if (this._controller.displayOnlyModifiedVars) {
			startingVars = this.modVars();
		} else {
			startingVars = this._allVars;
		}

		let vars = this._deltaVarSet.applyTo(startingVars, this._allVars);
		this._displayedVars = vars;

		if (vars.size === 0) {
			this.setContentFalse();
			return;
		}

		envs = this.filterLoops(envs);

		if (envs.length === 0) {
			this.setContentFalse();
			return;
		}

		// Generate header
		let rows: TableElement[][] = [];
		let header: TableElement[] = [];
		vars.forEach((v: string) => {
			header.push(new TableElement('**' + v + '**', 'header', 'header', 0));
		});
		rows.push(header);

		// Generate all rows
		for (let i = 0; i < envs.length; i++) {
			let env = envs[i];
			let loopID = env['$'];
			let iter = env['#'];
			let row: TableElement[] = [];
			vars.forEach((v: string) => {
				let v_str: string;
				if (env[v] === undefined) {
					v_str = '';
				} else if (isHtmlEscape(env[v])) {
					v_str = env[v];
				} else {
					v_str = '```python\n' + env[v] + '\n```';
				}
				row.push(new TableElement(v_str, loopID, iter, this.lineNumber, v, env));
			});
			rows.push(row);
		}

		// Set border
		if (this._controller.boxBorder) {
			this._box.style.border = '';
		} else {
			this._box.style.border = '0';
		}

		// Create html table from rows
		this._box.textContent = '';
		const renderer = new MarkdownRenderer(this._editor, this._modeService, this._openerService);
		let table = document.createElement('table');
		table.style.borderSpacing = '0px';
		table.style.paddingLeft = '13px';
		table.style.paddingRight = '13px';

		this._cellDictionary = {};
		if (this._controller.byRowOrCol === RowColMode.ByRow) {
			this.populateTableByRows(table, renderer, rows);
		} else {
			this.populateTableByCols(table, renderer, rows);
		}
		this._box.appendChild(table);

		this.addStalenessIndicator();

		//this.addConfigButton();
		if (this._controller.mouseShortcuts) {
			this.addPlusButton();
		}
	}

	private addStalenessIndicator() {
		// Add green/red dot to show out of date status
		let stalenessIndicator = document.createElement('div');
		stalenessIndicator.style.width = '5px';
		stalenessIndicator.style.height = '5px';
		stalenessIndicator.style.position = 'absolute';
		stalenessIndicator.style.top = '5px';
		stalenessIndicator.style.left = '3px';
		stalenessIndicator.style.borderRadius = '50%';
		let x = this._controller._changedLinesWhenOutOfDate;
		if (x === null) {
			stalenessIndicator.style.backgroundColor = 'green';
		} else {
			let green = 165 - (x.size - 1) * 35;
			if (green < 0) {
				green = 0;
			}
			stalenessIndicator.style.backgroundColor = 'rgb(255,' + green.toString() + ',0)';
		}

		this._box.appendChild(stalenessIndicator);
	}

	public varRemove(regExp: string, removed?: Set<string>) {
		if (regExp === '*') {
			regExp = '.*';
		}
		this.allVars().forEach((v) => {
			if (regExpMatchEntireString(v, regExp) && this._displayedVars.has(v)) {
				this._deltaVarSet.delete(v);
				if (removed !== undefined) {
					removed.add(v);
				}
			}
		});
	}

	public varRemoveAll(removed?: Set<string>) {
		this.varRemove('*', removed);
	}

	public varAdd(regExp: string, added?: Set<string>) {
		if (regExp === '*') {
			regExp = '.*';
		}
		this.allVars().forEach((v) => {
			if (regExpMatchEntireString(v, regExp) && !this._displayedVars.has(v)) {
				this._deltaVarSet.add(v);
				if (added !== undefined) {
					added.add(v);
				}
			}
		});
	}

	public varKeepOnly(regExp: string, added?: Set<string>, removed?: Set<string>) {
		this.varRemoveAll(removed);
		this._displayedVars.clear();
		this.varAdd(regExp, added);
	}

	public varAddAll(added?: Set<string>) {
		this.varAdd('*', added);
	}

	public varRestoreToDefault() {
		this._deltaVarSet.clear();
	}

	public varMakeVisible() {
		if (this._displayedVars.size === 0) {
			this.varRestoreToDefault();
		}
	}

	private newAction(label: string, actionCallBack: () => void): Action {
		return new Action('id', label, '', true, (event?) => {
			actionCallBack();
			return new Promise((resolve, reject) => {
				resolve();
			});
		});
	}

	private wrapAsVarMenuButton(elmt: HTMLElement, varname: string): HTMLDivElement {
		let menubar = document.createElement('div');
		menubar.className = 'menubar';
		if (this._controller.byRowOrCol === RowColMode.ByCol) {
			menubar.style.height = '23px';
		} else {
			menubar.style.height = '19.5px';
		}
		menubar.appendChild(elmt);
		elmt.className = 'menubar-menu-button';
		let c = this._controller;
		elmt.onclick = (e) => {
			e.stopImmediatePropagation();
			c.contextMenuService.showContextMenu({
				getAnchor: () => elmt,
				getActions: () => [
					this.newAction('Remove <strong> ' + varname + ' </strong> in This Box', () => {
						c.varRemoveInThisBox(varname, this);
					}),
					this.newAction('Remove <strong> ' + varname + ' </strong> in All Boxes', () => {
						c.varRemoveInAllBoxes(varname);
					}),
					this.newAction('Only <strong> ' + varname + ' </strong> in This Box', () => {
						c.varKeepOnlyInThisBox(varname, this);
					}),
					this.newAction('Only <strong> ' + varname + ' </strong> in All Boxes', () => {
						c.varKeepOnlyInAllBoxes(varname);
					})
				],
				onHide: () => { },
				autoSelectFirstItem: true
			});
		};
		return menubar;
	}

	private wrapAsLoopMenuButton(elmt: HTMLElement, iter: string): HTMLDivElement {
		let menubar = document.createElement('div');
		menubar.className = 'menubar';
		menubar.style.height = '19.5px';
		// if (this._controller.byRowOrCol === RowColMode.ByCol) {
		// 	menubar.style.height = '23px';
		// } else {
		// 	menubar.style.height = '19.5px';
		// }
		menubar.appendChild(elmt);
		elmt.className = 'menubar-menu-button';
		elmt.style.padding = '0px';
		let c = this._controller;
		elmt.onclick = (e) => {
			e.stopImmediatePropagation();
			c.contextMenuService.showContextMenu({
				getAnchor: () => elmt,
				getActions: () => [
					this.newAction('Focus on This Loop Iteration', () => {
						c.loopFocusController = new LoopFocusController(this._controller, this, iter);
					})
				],
				onHide: () => { },
				autoSelectFirstItem: true
			});
		};
		return menubar;
	}

	private addPlusButton() {
		let menubar = document.createElement('div');
		menubar.className = 'menubar';
		menubar.style.height = '23px';
		menubar.style.position = 'absolute';
		menubar.style.top = '0px';
		menubar.style.right = '0px';
		let addButton = document.createElement('div');
		menubar.appendChild(addButton);
		addButton.className = 'menubar-menu-button';
		addButton.innerHTML = '+';
		addButton.onclick = (e) => {
			e.stopImmediatePropagation();
			this._controller.contextMenuService.showContextMenu({
				getAnchor: () => addButton,
				getActions: () => this.createActionsForPlusMenu(),
				onHide: () => { },
				autoSelectFirstItem: true
			});

		};
		this._box.appendChild(menubar);

	}

	private createActionsForPlusMenu(): (IAction | ContextSubMenu)[] {
		let res: (IAction | ContextSubMenu)[] = [];
		this.notDisplayedVars().forEach((v) => {
			res.push(new ContextSubMenu('Add <strong> ' + v, [
				this.newAction('to This Box', () => {
					this._controller.varAddInThisBox(v, this);
				}),
				this.newAction('to All Boxes', () => {
					this._controller.varAddInAllBoxes(v);
				})
			]));
		});
		res.push(new ContextSubMenu('Add All Vars ', [
			this.newAction('to This Box', () => {
				this._controller.varAddAllInThisBox(this);
			}),
			this.newAction('to All Boxes', () => {
				this._controller.varAddAllInAllBoxes();
			})
		]));
		return res;
	}


	// public addConfigButton() {
	// 	let configButton = document.createElement('div');
	// 	let lines: HTMLElement[] = [];

	// 	for(let i = 0; i < 3; i++){
	// 		let hamburgerIconLine = document.createElement('div');
	// 		hamburgerIconLine.style.width = '90%';
	// 		hamburgerIconLine.style.height = '10%';
	// 		hamburgerIconLine.style.margin =  '20% 0%';
	// 		hamburgerIconLine.style.backgroundColor = 'black';
	// 		configButton.appendChild(hamburgerIconLine);
	// 		lines.push(hamburgerIconLine);
	// 	}
	// 	lines[0].style.transition = 'transform 0.2s';
	// 	lines[2].style.transition = 'transform 0.2s';

	// 	configButton.style.width = '10px';
	// 	configButton.style.height = '10px';
	// 	configButton.style.position = 'absolute';
	// 	configButton.style.top = '5px';
	// 	configButton.style.right = '2px';
	// 	if(configButton){
	// 		configButton.onclick = (e) =>{
	// 			e.stopPropagation();
	// 			if(this._coordinator._configBox){
	// 				console.log(this._coordinator._configBox.style.display);
	// 				this._coordinator.showOrHideConfigDialogBox();
	// 			}
	// 			else{
	// 				this._coordinator.addConfigDialogBox();
	// 			}
	// 			if(lines[1].style.opacity !== '0'){
	// 				lines[0].style.transform = 'translate(0%, 3px) rotate(-45deg)';
	// 				lines[2].style.transform = 'translate(0%, -3px) rotate(45deg)';
	// 				lines[1].style.opacity = '0';
	// 				console.log(lines[2]);
	// 			}else{
	// 				lines[0].style.transform = 'translate(0%, 0px) rotate(0deg)';
	// 				lines[1].style.opacity = '1';
	// 				lines[2].style.transform = 'translate(0%, 0px) rotate(0deg)';
	// 			}

	// 		};
	// 	}
	// 	this._box.appendChild(configButton);
	// }


	public getHeight() {
		return this._box.offsetHeight * this._zoom;
	}

	public updateLayout(top: number) {
		let pixelPosAtLine = this._controller.getLinePixelPos(this.lineNumber);

		let boxTop = top;
		if (this._controller.boxAlignsToTopOfLine) {
			boxTop = boxTop - (pixelPosAtLine.height / 2);
		}
		//let left = this._controller.maxPixelCol+50;
		let left = this._controller.maxPixelCol + 130;
		let zoom_adjusted_left = left - ((1 - this._zoom) * (this._box.offsetWidth / 2));
		let zoom_adjusted_top = boxTop - ((1 - this._zoom) * (this._box.offsetHeight / 2));
		this._box.style.top = zoom_adjusted_top.toString() + 'px';
		this._box.style.left = zoom_adjusted_left.toString() + 'px';
		this._box.style.transform = 'scale(' + this._zoom.toString() + ')';
		this._box.style.opacity = this._opacity.toString();

		// update the line
		let midPointTop = pixelPosAtLine.top + (pixelPosAtLine.height / 2);

		//this._line.move(this._controller.maxPixelCol-50, midPointTop, left, top);
		this._line.move(this._controller.maxPixelCol + 30, midPointTop, left, top);

	}

	public updateZoomAndOpacity(dist: number, opacityMult: number) {
		let distAbs = Math.abs(dist);
		let zoom_upper = 1;
		let zoom_lower = 1 / (distAbs * 0.5 + 1);
		this._zoom = zoom_lower + (zoom_upper - zoom_lower) * this._controller.zoomLevel;

		this._opacity = 1;
		if (distAbs !== 0) {
			let opacity_upper = 1;
			let opacity_lower = 1 / distAbs;
			this._opacity = opacity_lower + (opacity_upper - opacity_lower) * this._controller.opacityLevel;
		}
		this._opacity = this._opacity * opacityMult;
		this._line.setOpacity(this._opacity);
	}

	public fade() {
		let oldOpacity = this._box.style.opacity === '' ? '1' : this._box.style.opacity;
		if (oldOpacity) {
			let newOpacity = parseFloat(oldOpacity) * 0.9;
			this._box.style.opacity = newOpacity.toString();
			this._line.setOpacity(newOpacity);
			this._opacity = newOpacity;
		}
	}

}

enum RowColMode {
	ByRow = 'By Row',
	ByCol = 'By Col'
}

enum ViewMode {
	Full = 'Full',
	CursorAndReturn = 'Cursor and Return',
	Compact = 'Compact',
	Stealth = 'Stealth',
	Focused = 'Focused',
	Custom = 'Custom'
}

enum ChangeVarsWhere {
	Here = 'here',
	All = 'all',
}

enum ChangeVarsOp {
	Add = 'add',
	Del = 'del',
	Keep = 'keep'
}

class LoopFocusController {

	private _loopIDArr: number[];
	private _iterArr: number[];
	private _decoration1?: string;
	private _decoration2?: string;
	private _decoration3?: string;
	constructor(
		private readonly _controller: RTVController,
		public readonly controllingBox: RTVDisplayBox,
		public readonly iter: string,
	) {
		this._iterArr = strNumsToArray(iter);
		this._loopIDArr = strNumsToArray(controllingBox.getLoopID());
		this.resetDecorations(true);
	}

	public resetDecorations(addEndToken = false) {
		this.destroyDecorations();
		if (this.hasSeed()) {
			let seedLineno = this.controllingBox.lineNumber;
			let model = this._controller.getModelForce();
			let lines = model.getLinesContent();
			let currIndent = indent(lines[seedLineno - 1]);
			let start = seedLineno;
			function isStillInLoop(s: string) {
				return isEmpty(s) || indent(s) >= currIndent;
			}
			while (start >= 1 && isStillInLoop(lines[start - 1])) {
				start = start - 1;
			}
			let end = seedLineno;
			while (end < lines.length + 1 && isStillInLoop(lines[end - 1])) {
				end = end + 1;
			}

			let range1 = new Range(1, 1, start, model.getLineMaxColumn(start));
			let maxline = lines.length;
			let range2 = new Range(end, 1, maxline, model.getLineMaxColumn(maxline));
			let seedLineContent = lines[seedLineno - 1];
			let range3 = new Range(seedLineno, indent(seedLineContent) + 1, seedLineno, seedLineContent.length + 1);
			this._decoration1 = this._controller.addDecoration(range1, { inlineClassName: 'rtv-code-fade' });
			this._decoration2 = this._controller.addDecoration(range2, { inlineClassName: 'rtv-code-fade' });
			this._decoration3 = this._controller.addDecoration(range3, { className: 'squiggly-info' });

			let endToken = '## END LOOP';
			if (addEndToken && !lines[end - 2].endsWith(endToken)) {
				let endCol = model.getLineMaxColumn(end - 1);
				let range4 = new Range(end - 1, endCol, end - 1, endCol);
				this._controller.executeEdits([{ range: range4, text: '\n' + seedLineContent.substr(0, currIndent) + endToken }]);
			}
		}
	}

	public destroyDecorations() {
		if (this._decoration1) {
			this._controller.removeDecoration(this._decoration1);
		}
		if (this._decoration2) {
			this._controller.removeDecoration(this._decoration2);
		}
		if (this._decoration3) {
			this._controller.removeDecoration(this._decoration3);
		}
	}

	public hasSeed(): boolean {
		return isSeedLine(this.controllingBox.getLineContent());
	}

	public matchesIter(otherIter: string): boolean {
		let otherIterArr = strNumsToArray(otherIter);
		return arrayStartsWith(otherIterArr, this._iterArr);
	}

	public matchesID(otherLoopID: string): boolean {
		let otherLoopsLinenoArr = strNumsToArray(otherLoopID);
		return arrayStartsWith(otherLoopsLinenoArr, this._loopIDArr);
	}

	public matches(otherLoopID: string, otherIter: string): boolean {
		this._loopIDArr = strNumsToArray(this.controllingBox.getLoopID());
		return this.matchesID(otherLoopID) && this.matchesIter(otherIter);
	}

}


type VisibilityPolicy = (b: RTVDisplayBox, cursorLineNumber: number) => boolean;

function visibilityAll(b: RTVDisplayBox, cursorLineNumber: number) {
	return true;
}

function visibilityNone(b: RTVDisplayBox, cursorLineNumber: number) {
	return false;
}

function visibilityCursor(b: RTVDisplayBox, cursorLineNumber: number) {
	return b.lineNumber === cursorLineNumber;
}

function visibilityCursorAndReturn(b: RTVDisplayBox, cursorLineNumber: number) {
	return b.lineNumber === cursorLineNumber || b.isReturnLine();
}

// enum LangId {
// 	NotSupported = 0,
// 	Python = 1,
// 	Haskell = 2
// }

class RTVController implements IEditorContribution {
	public envs: { [k: string]: any[]; } = {};
	public writes: { [k: string]: string[]; } = {};
	private _boxes: RTVDisplayBox[] = [];
	private _maxPixelCol = 0;
	private _prevModel: string[] = [];
	public _changedLinesWhenOutOfDate: Set<number> | null = null;
	public _configBox: HTMLDivElement | null = null;
	public tableCellsByLoop: MapLoopsToCells = {};
	public logger: RTVLogger;
	private _config: ConfigurationServiceCache;
	private _makeNewBoxesVisible: boolean = true;
	private _loopFocusController: LoopFocusController | null = null;
	private _errorDecorationID: string | null = null;
	private _errorDisplayTimer: ReturnType<typeof setTimeout> | null = null;
	private _visibilityPolicy: VisibilityPolicy = visibilityAll;
	private _peekCounter: number = 0;
	private _peekTimer: ReturnType<typeof setTimeout> | null = null;
	private _globalDeltaVarSet: DeltaVarSet = new DeltaVarSet();
	private _pythonProcess?: utils.Process = undefined;
	private _runProgramDelay: DelayedRunAtMostOne = new DelayedRunAtMostOne();

	public static readonly ID = 'editor.contrib.rtv';

	constructor(
		private readonly _editor: ICodeEditor,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IModeService private readonly _modeService: IModeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService public readonly contextMenuService: IContextMenuService,
		@IThemeService readonly _themeService: IThemeService,
		//@IModelService private readonly _modelService: IModelService,
	) {
		this._editor.onDidChangeCursorPosition((e) => { this.onDidChangeCursorPosition(e); });
		this._editor.onDidScrollChange((e) => { this.onDidScrollChange(e); });
		this._editor.onDidLayoutChange((e) => { this.onDidLayoutChange(e); });
		this._editor.onDidChangeModelContent((e) => { this.onDidChangeModelContent(e); });
		this._editor.onDidChangeModel((e) => {
			if (this._editor.getModel() !== null) {
				this._boxes = [];
				this.envs = {};
				this.writes = {};
				this.runProgram();
			}
		});
		this._editor.onDidChangeModelLanguage((e) => { this.runProgram(); });
		this._editor.onMouseWheel((e) => { this.onMouseWheel(e); });
		this._editor.onKeyUp((e) => { this.onKeyUp(e); });
		this._editor.onKeyDown((e) => { this.onKeyDown(e); });
		//this._modelService.onModelModeChanged((e) => { console.log('BBBB');  });

		this.logger = utils.getLogger(this._editor);

		for (let i = 0; i < this.getLineCount(); i++) {
			this._boxes.push(new RTVDisplayBox(this, _editor, _modeService, _openerService, i + 1, this._globalDeltaVarSet));
		}

		this.updateMaxPixelCol();

		this._config = new ConfigurationServiceCache(configurationService);
		this._config.onDidUserChangeConfiguration = (e) => {
			this.onUserChangeConfiguration(e);
		};
		this.changeViewMode(this.viewMode);

		//this._modVarsInputField.getDomNode().style.width = '300px';
	}

	public static get(editor: ICodeEditor): RTVController {
		return editor.getContribution<RTVController>(RTVController.ID);
	}

	public getId(): string {
		return RTVController.ID;
	}

	public dispose(): void {
		this.logger.dispose();
	}

	public restoreViewState(state: any): void {
	}

	// Configurable properties
	get boxAlignsToTopOfLine(): boolean {
		return this._config.getValue(boxAlignsToTopOfLineKey);
	}
	set boxAlignsToTopOfLine(v: boolean) {
		this._config.updateValue(boxAlignsToTopOfLineKey, v);
	}

	get boxBorder(): boolean {
		return this._config.getValue(boxBorderKey);
	}
	set boxBorder(v: boolean) {
		this._config.updateValue(boxBorderKey, v);
	}

	get byRowOrCol(): RowColMode {
		return this._config.getValue(byRowOrColKey);
	}
	set byRowOrCol(v: RowColMode) {
		this._config.updateValue(byRowOrColKey, v);
	}

	get cellPadding(): number {
		return this._config.getValue(cellPaddingKey);
	}
	set cellPadding(v: number) {
		this._config.updateValue(cellPaddingKey, v);
	}

	get colBorder(): boolean {
		return this._config.getValue(colBorderKey);
	}
	set colBorder(v: boolean) {
		this._config.updateValue(colBorderKey, v);
	}

	get displayOnlyModifiedVars(): boolean {
		return this._config.getValue(displayOnlyModifiedVarsKey);
	}
	set displayOnlyModifiedVars(v: boolean) {
		this._config.updateValue(displayOnlyModifiedVarsKey, v);
	}

	get opacityLevel(): number {
		return this._config.getValue(opacityKey);
	}
	set opacityLevel(v: number) {
		this._config.updateValue(opacityKey, v);
	}

	get showBoxAtLoopStmt(): boolean {
		return this._config.getValue(showBoxAtLoopStmtKey);
	}
	set showBoxAtLoopStmt(v: boolean) {
		this._config.updateValue(showBoxAtLoopStmtKey, v);
	}

	get spaceBetweenBoxes(): number {
		return this._config.getValue(spaceBetweenBoxesKey);
	}
	set spaceBetweenBoxes(v: number) {
		this._config.updateValue(spaceBetweenBoxesKey, v);
	}

	get zoomLevel(): number {
		return this._config.getValue(zoomKey);
	}
	set zoomLevel(v: number) {
		this._config.updateValue(zoomKey, v);
	}

	get viewMode(): ViewMode {
		return this._config.getValue(viewModeKey);
	}
	set viewMode(v: ViewMode) {
		this._config.updateValue(viewModeKey, v);
	}

	get mouseShortcuts(): boolean {
		return this._config.getValue(mouseShortcutsKey);
	}
	set mouseShortcuts(v: boolean) {
		this._config.updateValue(mouseShortcutsKey, v);
	}

	get supportSynthesis(): boolean {
		return this._config.getValue(supportSynthesisKey);
	}
	set supportSynthesis(v: boolean) {
		this._config.updateValue(supportSynthesisKey, v);
	}

	// End of configurable properties

	get maxPixelCol() {
		return this._maxPixelCol;
	}

	get loopFocusController(): LoopFocusController | null {
		return this._loopFocusController;
	}

	set loopFocusController(lc: LoopFocusController | null) {
		this._loopFocusController?.destroyDecorations();
		this._loopFocusController = lc;
		this.runProgram();
	}

	public changeToCompactView() {
		this.boxAlignsToTopOfLine = true;
		this.boxBorder = false;
		this.byRowOrCol = RowColMode.ByRow;
		this.cellPadding = 6;
		this.colBorder = true;
		this.displayOnlyModifiedVars = true;
		this.showBoxAtLoopStmt = true;
		this.spaceBetweenBoxes = -4;
		this.zoomLevel = 1;
		this.opacityLevel = 1;
		this.restoreAllBoxesToDefault();
	}

	public changeToFullView(zoom?: 0 | 1) {
		this.boxAlignsToTopOfLine = false;
		this.boxBorder = true;
		this.byRowOrCol = RowColMode.ByCol;
		this.cellPadding = 6;
		this.colBorder = false;
		this.displayOnlyModifiedVars = false;
		this.showBoxAtLoopStmt = false;
		this.spaceBetweenBoxes = 20;
		if (zoom === 1) {
			this.zoomLevel = 1;
			this.opacityLevel = 1;
		} else {
			this.zoomLevel = 0;
			this.opacityLevel = 0;
		}
		this.restoreAllBoxesToDefault();
	}

	private onUserChangeConfiguration(e: IConfigurationChangeEvent) {
		if (e.affectedKeys.indexOf(viewModeKey) !== -1) {
			this.changeViewMode(this.viewMode);
		} else if (e.affectedKeys.some((s) => strings.startsWith(s, 'rtv'))) {
			this.viewMode = ViewMode.Custom;
		}
	}

	public getModelForce(): ITextModel {
		let model = this._editor.getModel();
		if (model === null) {
			throw Error('Expecting a model');
		}
		return model;
	}

	private getLineCount(): number {
		let model = this._editor.getModel();
		if (model === null) {
			return 0;
		}
		return model.getLineCount();
	}

	public getLineContent(lineNumber: number): string {
		let model = this._editor.getModel();
		if (model === null) {
			return '';
		}
		return model.getLineContent(lineNumber);
	}

	// private getLangId(): LangId {
	// 	let model = this._editor.getModel();
	// 	if (model === null) {
	// 		return LangId.NotSupported;
	// 	}
	// 	let uri = model.uri;
	// 	if (uri.scheme !== 'file') {
	// 		return LangId.NotSupported;
	// 	}
	// 	if (strings.endsWith(uri.path, '.py')) {
	// 		return LangId.Python;
	// 	}
	// 	if (strings.endsWith(uri.path, '.hs')) {
	// 		return LangId.Haskell
	// 	}
	// 	return LangId.NotSupported;
	// }

	private updateMaxPixelCol() {
		let model = this._editor.getModel();
		if (model === null) {
			return;
		}
		let max = 0;
		let lineCount = model.getLineCount();
		for (let line = 1; line <= lineCount; line++) {
			let s = model.getLineContent(line);
			if (s.length > 0 && s[0] === '#') {
				continue;
			}
			let col = model.getLineMaxColumn(line);
			let pixelPos = this._editor.getScrolledVisiblePosition(new Position(line, col));
			if (pixelPos !== null && pixelPos.left > max) {
				max = pixelPos.left;
			}
		}
		this._maxPixelCol = max;
	}

	public showOrHideConfigDialogBox() {
		if (!this._configBox) {
			return;
		}
		this._configBox.style.display = this._configBox.style.display === 'block' ? 'none' : 'block';
	}

	public addConfigDialogBox() {
		let editor_div = this._editor.getDomNode();
		if (!editor_div) {
			return;
		}
		let div = document.createElement('div');
		div.textContent = '';
		div.style.position = 'absolute';
		div.style.top = '200px';
		div.style.left = '800px';
		div.style.width = '100px';
		div.style.textAlign = 'left';
		div.style.transitionProperty = 'all';
		div.style.transitionDuration = '0.3s';
		div.style.transitionDelay = '0s';
		div.style.transitionTimingFunction = 'ease-in';
		div.style.boxShadow = '0px 2px 8px black';
		div.className = 'monaco-hover';
		div.style.display = 'block';

		/*Creates the row selector
		let row = document.createElement('div');
		let currColor = '#9effb1';
		row.textContent = 'Row';
		row.style.backgroundColor = this._row ? currColor : 'transparent';
		row.onclick = (e) => {
			e.stopImmediatePropagation();
			//Change row
			this._row = true;
			row.style.backgroundColor = this._row ? currColor : 'transparent';
			column.style.backgroundColor = this._row ? 'transparent' : currColor;
		};
		row.style.cssFloat = 'left';
		row.style.width = '35%';
		row.style.margin = '8px';
		row.style.padding = '5px';
		div.appendChild(row);

		//Creates the column selector
		let column = document.createElement('div');
		column.textContent = 'Column';
		column.style.backgroundColor = this._row ? 'transparent' : currColor;
		column.onclick = (e) => {
			e.stopImmediatePropagation();
			//Change col
			this._row = false;
			column.style.backgroundColor = this._row ? 'transparent' : currColor;
			row.style.backgroundColor = this._row ? currColor : 'transparent';
		};
		column.style.width = '35%';
		column.style.margin = '8px';
		column.style.cssFloat = 'right';
		column.style.padding = '5px';
		div.appendChild(column);*/

		let row = document.createElement('input');
		row.type = 'radio';
		row.name = 'row-or-col';
		row.value = 'row';
		row.textContent = 'Row';

		let rowText = document.createElement('label');
		rowText.innerText = 'Row';

		div.appendChild(row);
		div.appendChild(rowText);
		div.appendChild(document.createElement('br'));

		let col = document.createElement('input');
		col.type = 'radio';
		col.name = 'row-or-col';
		col.value = 'col';

		let colText = document.createElement('label');
		colText.innerText = 'Col';
		div.appendChild(col);
		div.appendChild(colText);
		div.appendChild(document.createElement('br'));

		editor_div.appendChild(div);
		this._configBox = div;
	}

	private updateLinesWhenOutOfDate(exitCode: number | null, e?: IModelContentChangedEvent) {
		if (e === undefined) {
			return;
		}
		if (exitCode === 0) {
			this._changedLinesWhenOutOfDate = null;
			return;
		}
		if (this._changedLinesWhenOutOfDate === null) {
			this._changedLinesWhenOutOfDate = new Set();
		}
		let s = this._changedLinesWhenOutOfDate;
		e.changes.forEach((change) => {
			for (let i = change.range.startLineNumber; i <= change.range.endLineNumber; i++) {
				s.add(i);
			}
		});
	}

	private getBox(lineNumber: number) {
		let i = lineNumber - 1;
		if (i >= this._boxes.length) {
			for (let j = this._boxes.length; j <= i; j++) {
				this._boxes[j] = new RTVDisplayBox(this, this._editor, this._modeService, this._openerService, j + 1, this._globalDeltaVarSet);
			}
		}
		return this._boxes[i];
	}

	public getBoxAtCurrLine() {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			throw new Error('No position to get box at');
		}

		return this.getBox(cursorPos.lineNumber);
	}

	private padBoxArray() {
		let lineCount = this.getLineCount();
		if (lineCount > this._boxes.length) {
			for (let j = this._boxes.length; j < lineCount; j++) {
				this._boxes[j] = new RTVDisplayBox(this, this._editor, this._modeService, this._openerService, j + 1, this._globalDeltaVarSet);
			}
		}
	}

	private onDidChangeCursorPosition(e: ICursorPositionChangedEvent) {
		this.updateLayout();
	}

	private onDidScrollChange(e: IScrollEvent) {
		if (e.scrollHeightChanged || e.scrollWidthChanged) {
			// this means the content also changed, so we will let the onChangeModelContent event handle it
			return;
		}
		this.updateMaxPixelCol();
		this.updateLayout();
	}

	private onDidLayoutChange(e: EditorLayoutInfo) {
		this.updateMaxPixelCol();
		this.updateLayout();
	}

	private onDidChangeModelContent(e: IModelContentChangedEvent) {
		this.runProgram(e);
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}
		let lineno = cursorPos.lineNumber;
		if (e.changes.length > 0) {
			let range = e.changes[0].range;
			let lineCount = this.getLineCount();
			for (let i = range.startLineNumber; i <= range.endLineNumber; i++) {
				if (i <= lineCount && i === lineno) {
					if (isSeedLine(this.getLineContent(i))) {
						this.focusOnLoopWithSeed();
					}
					if (this.supportSynthesis) {
						let listOfElems = this.getLineContent(i).split('=');
						if (listOfElems.length === 2 && listOfElems[1].trim().endsWith('??')) {
							this.editingVar();
							return;
						}
					}
				}
			}
		}
		if (this.loopFocusController !== null) {
			this.loopFocusController.resetDecorations();
		}
	}

	private updateCellSizesForNewContent() {
		if (this.byRowOrCol !== RowColMode.ByRow) {
			return;
		}

		// Compute set of loop iterations
		let loops: string[] = [];
		for (let loop in this.tableCellsByLoop) {
			loops.push(loop);
		}
		// sort by deeper iterations first
		loops = loops.sort((a, b) => b.split(',').length - a.split(',').length);

		let widths: { [k: string]: number; } = {};
		loops.forEach((loop: string) => {
			widths[loop] = Math.max(...this.tableCellsByLoop[loop].map(e => e.offsetWidth));
			//console.log('Max for ' + loop + ' :' + widths[loop]);
		});

		let spaceBetweenCells = 2 * this.cellPadding;
		if (this.colBorder) {
			spaceBetweenCells = spaceBetweenCells + 1;
		}
		for (let i = 1; i < loops.length; i++) {
			let width = 0;
			let parent_loop = loops[i];
			for (let j = 0; j < i; j++) {
				let child_loop = loops[j];
				if (child_loop.split(',').length === 1 + parent_loop.split(',').length &&
					strings.startsWith(child_loop, parent_loop)) {
					width = width + widths[child_loop];
					//width = width + widths[child_loop] + spaceBetweenCells;
				}
			}
			if (width !== 0) {
				//width = width - spaceBetweenCells;
				widths[parent_loop] = width;
			}
		}

		loops.forEach((loop: string) => {
			// console.log('Computed width for ' + loop + ': ' + widths[loop]);
			this.tableCellsByLoop[loop].forEach(e => { e.width = (widths[loop] - spaceBetweenCells) + 'px'; });
		});

	}
	public updateContentAndLayout() {
		this.tableCellsByLoop = {};
		this.updateContent();
		// The 0 timeout seems odd, but it's really a thing in browsers.
		// We need to let layout threads catch up after we updated content to
		// get the correct sizes for boxes.
		setTimeout(() => {
			for (let x in this.tableCellsByLoop) {
				this.tableCellsByLoop[x].forEach(y => {
					//console.log('Delayed: ' + x + ' ' + y.offsetWidth + ' ' + y.clientWidth);
				});
			}
			this.updateCellSizesForNewContent();
			this.updateLayout();
		}, 0);
	}

	private updateContent() {
		this.padBoxArray();
		if (this.loopFocusController !== null) {
			// if we are focused on a loop, compute envs at the controlling box first
			// so that it's loop iterations are set properly, so that getLoopID works
			this.loopFocusController.controllingBox.computeEnvs();
		}
		this._boxes.forEach((b) => {
			b.updateContent();
		});
	}

	private updateLayoutHelper(toProcess: (b: RTVDisplayBox) => boolean, opacityMult: number) {
		this.padBoxArray();

		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}

		// Compute focused line, which is the closest line to the cursor with a visible box
		let minDist = Infinity;
		let focusedLine = 0;
		for (let line = 1; line <= this.getLineCount(); line++) {
			if (toProcess(this.getBox(line))) {
				let dist = Math.abs(cursorPos.lineNumber - line);
				if (dist < minDist) {
					minDist = dist;
					focusedLine = line;
				}
			}
		}
		// this can happen if no boxes are to be processed
		if (minDist === Infinity) {
			return;
		}

		// compute distances from focused line, ignoring hidden lines.
		// Start from focused line and go outward.
		let distancesFromFocus: number[] = new Array(this._boxes.length);
		let dist = 0;
		for (let line = focusedLine; line >= 1; line--) {
			if (toProcess(this.getBox(line))) {
				distancesFromFocus[line - 1] = dist;
				dist = dist - 1;
			}
		}
		dist = 1;
		for (let line = focusedLine + 1; line <= this.getLineCount(); line++) {
			if (toProcess(this.getBox(line))) {
				distancesFromFocus[line - 1] = dist;
				dist = dist + 1;
			}
		}

		for (let line = 1; line <= this.getLineCount(); line++) {
			let box = this.getBox(line);
			if (toProcess(this.getBox(line))) {
				box.updateZoomAndOpacity(distancesFromFocus[line - 1], opacityMult);
			}
		}
		// let cursorPixelPos = this._editor.getScrolledVisiblePosition(cursorPos);
		// let nextLinePixelPos = this._editor.getScrolledVisiblePosition(new Position(cursorPos.lineNumber+1,cursorPos.column));
		// if (cursorPixelPos === null || nextLinePixelPos === null) {
		// 	return;
		// }

		let focusedLinePixelPos = this._editor.getScrolledVisiblePosition(new Position(focusedLine, 1));
		let nextLinePixelPos = this._editor.getScrolledVisiblePosition(new Position(focusedLine + 1, 1));
		if (focusedLinePixelPos === null || nextLinePixelPos === null) {
			return;
		}

		let spaceBetweenBoxes = this.spaceBetweenBoxes;
		// let top_start = focusedLinePixelPos.top + (focusedLinePixelPos.height / 2);
		//let top_start = (focusedLinePixelPos.top + nextLinePixelPos.top) / 2;
		//let top_start = focusedLinePixelPos.top;
		let top_start = this.getLinePixelMid(focusedLine);
		let top = top_start;
		for (let line = focusedLine - 1; line >= 1; line--) {
			let box = this.getBox(line);
			if (toProcess(box)) {
				top = top - spaceBetweenBoxes - box.getHeight();
				let lineMidPoint = this.getLinePixelMid(line);
				if (lineMidPoint < top) {
					top = lineMidPoint;
				}
				box.updateLayout(top);
			}
		}
		top = top_start;
		for (let line = focusedLine; line <= this.getLineCount(); line++) {
			let box = this.getBox(line);
			if (toProcess(box)) {
				let lineMidPoint = this.getLinePixelMid(line);
				if (lineMidPoint > top) {
					top = lineMidPoint;
				}
				box.updateLayout(top);
				top = top + box.getHeight() + spaceBetweenBoxes;
			}
		}

	}

	private updateLayout() {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}
		let curr = cursorPos.lineNumber;
		this.updateLayoutHelper(b => b.hasContent(), 0);
		this.updateLayoutHelper(b => b.hasContent() && this._visibilityPolicy(b, curr), 1);
	}

	public getLinePixelPos(line: number): { top: number; left: number; height: number; } {
		// let result = this._editor.getScrolledVisiblePosition(new Position(line, 1));
		// if (result === null) {
		// 	throw new Error();
		// }
		// return result;
		return this.getLineColPixelPos(new Position(line, 1));
	}

	public getLineColPixelPos(position: IPosition): { top: number; left: number; height: number; } {
		let result = this._editor.getScrolledVisiblePosition(position);
		if (result === null) {
			throw new Error();
		}
		return result;
	}

	public getLinePixelMid(line: number): number {
		let pixelPos = this.getLinePixelPos(line);
		return pixelPos.top + (pixelPos.height / 2);
	}

	private updatePrevModel() {
		let model = this._editor.getModel();
		if (model !== null) {
			this._prevModel = model.getLinesContent().map((x) => x);
		}
	}

	public lastNonWhitespaceCol(lineNumber: number, lines?: string[]): number {
		let line = (lines === undefined) ? this.getLineContent(lineNumber) : lines[lineNumber - 1];
		const result = strings.lastNonWhitespaceIndex(line);
		if (result === -1) {
			return 0;
		}
		return result + 2;
	}

	public firstNonWhitespaceCol(lineNumber: number, lines?: string[]): number {
		let line = (lines === undefined) ? this.getLineContent(lineNumber) : lines[lineNumber - 1];
		const result = strings.firstNonWhitespaceIndex(line);
		if (result === -1) {
			return 0;
		}
		return result + 1;
	}

	private addRemoveBoxes(e?: IModelContentChangedEvent) {
		if (e === undefined) {
			this.updatePrevModel();
			return;
		}
		let orig = this._boxes;
		let changes = e.changes.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
		let changeIdx = 0;
		let origIdx = 0;
		let i = 0;
		this._boxes = [];
		let lineCount = this.getLineCount();
		while (i < lineCount) {
			if (changeIdx >= changes.length) {
				this._boxes[i++] = orig[origIdx++];
				this._boxes[i - 1].lineNumber = i;
			} else {
				let line = i + 1;
				let change = changes[changeIdx];
				let numAddedLines = change.text.split('\n').length - 1;
				let changeStartLine = change.range.startLineNumber;
				let changeEndLine = change.range.endLineNumber;
				let numRemovedLines = changeEndLine - changeStartLine;
				let deltaNumLines = numAddedLines - numRemovedLines;
				let changeStartCol = change.range.startColumn;
				if ((deltaNumLines <= 0 && changeStartLine === line) ||
					(deltaNumLines > 0 && ((changeStartLine === line && changeStartCol < this.lastNonWhitespaceCol(line, this._prevModel)) ||
						(changeStartLine === line - 1 && changeStartCol >= this.lastNonWhitespaceCol(line - 1, this._prevModel))))) {
					changeIdx++;
					if (deltaNumLines === 0) {
						// nothing to do
					} else if (deltaNumLines > 0) {
						for (let j = 0; j < deltaNumLines; j++) {
							let new_box = new RTVDisplayBox(this, this._editor, this._modeService, this._openerService, i + 1, this._globalDeltaVarSet);
							if (!this._makeNewBoxesVisible) {
								new_box.varRemoveAll();
							}
							this._boxes[i++] = new_box;
						}
					} else {
						for (let j = origIdx; j < origIdx + (-deltaNumLines); j++) {
							orig[j].destroy();
						}
						// need to make the removed boxes disappear
						origIdx = origIdx + (-deltaNumLines);
					}
				}
				else {
					this._boxes[i++] = orig[origIdx++];
					this._boxes[i - 1].lineNumber = i;
				}
			}
		}
		this.updatePrevModel();
	}

	public addDecoration(range: IRange, options: IModelDecorationOptions) {
		let result = '';
		this._editor.changeDecorations((c) => {
			result = c.addDecoration(range, options);
		});
		return result;
	}

	public removeDecoration(id: string) {
		this._editor.changeDecorations((c) => {
			c.removeDecoration(id);
		});
	}

	private showErrorWithDelay(errorMsg: string) {
		if (this._errorDisplayTimer !== null) {
			clearTimeout(this._errorDisplayTimer);
		}
		this._errorDisplayTimer = setTimeout(() => {
			this._errorDisplayTimer = null;
			this.clearError();
			this.showError(errorMsg);
		}, 600);
	}

	private showError(errorMsg: string) {
		// There are two kinds of errors:
		//
		// I. Runtime errors, which end like this:
		//
		// File '<string>', line 4, in mean_average'
		// TypeError: list indices must be integers or slices, not float
		//
		// II. Parse errors, which end like this:
		//
		// File '<unknown>', line 4
		//    median = a[int(mid ]
		//                       ^
		// SyntaxError: invalid syntax

		let lineNumber = 0;
		let colStart = 0;
		let colEnd = 0;

		let errorLines = errorMsg.split(utils.EOL);
		errorLines.pop(); // last element is empty line

		// The error description is always the last line
		let description = errorLines.pop();
		if (description === undefined) {
			return;
		}

		// Let's look at the next-to-last line, and try to parse as
		// a runtime error, in which case there should be a line number
		let lineno = errorLines.pop();
		if (lineno === undefined) {
			return;
		}
		let linenoRE = 'line ([0-9]*)';
		let match = lineno.match(linenoRE);

		if (match !== null) {
			// found a line number here, so this is a runtime error)
			// match[0] is entire 'line N' match, match[1] is just the number N
			lineNumber = +match[1];
			colStart = this.firstNonWhitespaceCol(lineNumber);
			colEnd = this.lastNonWhitespaceCol(lineNumber);
		} else {
			// No line number here so this is a syntax error, so we in fact
			// didn't get the error line number, we got the line with the caret
			let caret = lineno;

			let caretIndex = caret.indexOf('^');
			if (caretIndex === -1) {
				// can't figure out the format, give up
				return;
			}

			// It's always indented 4 extra spaces
			caretIndex = caretIndex - 4;

			// Next line going backwards is the line of code above the caret
			errorLines.pop();

			// this should now be the line number
			lineno = errorLines.pop();
			if (lineno === undefined) {
				return;
			}

			match = lineno.match(linenoRE);
			if (match === null) {
				// can't figure out the format, give up
				return;
			} else {
				// found a line number here, so this is a runtime error)
				// match[0] is entire 'line N' match, match[1] is just the number N
				lineNumber = +match[1];
				colStart = this.firstNonWhitespaceCol(lineNumber) + caretIndex;
				if (colStart < 1) {
					colStart = 1;
				}
				colEnd = colStart + 1;
			}
		}
		let range = new Range(lineNumber, colStart, lineNumber, colEnd);
		let options = { className: 'squiggly-error', hoverMessage: new MarkdownString(description) };
		this._errorDecorationID = this.addDecoration(range, options);
	}

	private clearError() {
		if (this._errorDisplayTimer !== null) {
			clearTimeout(this._errorDisplayTimer);
			this._errorDisplayTimer = null;
		}
		if (this._errorDecorationID !== null) {
			this.removeDecoration(this._errorDecorationID);
			this._errorDecorationID = null;
		}
	}

	private insertSynthesizedFragment(fragment: string, lineno: number) {
		let model = this.getModelForce();
		let cursorPos = this._editor.getPosition();
		let startCol: number;
		let endCol: number;

		if (model.getLineContent(lineno).trim() === '' && cursorPos !== null && cursorPos.lineNumber === lineno) {
			startCol = cursorPos.column;
			endCol = cursorPos.column;
		} else {
			startCol = model.getLineFirstNonWhitespaceColumn(lineno);
			endCol = model.getLineMaxColumn(lineno);
		}
		let range = new Range(lineno, startCol, lineno, endCol);

		this._editor.pushUndoStop();
		let selection = new Selection(lineno, startCol, lineno, startCol + fragment.length);
		this._editor.executeEdits(this.getId(), [{ range: range, text: fragment }], [selection]);
	}

	private getVarAssignmentAtLine(lineNo: number): null | string {
		let line = this.getLineContent(lineNo).trim();
		if (!line) { return null; }
		let content = line.split('=');
		if (content.length !== 2) { return null; }
		return content[0].trim();
	}

	public synthesizeFragment(lineno: number, timesToInclude: Set<number>) {
		let varName = this.getVarAssignmentAtLine(lineno);

		// Build and write the synth_example.json file content
		let envs: any[] = [];

		search_loop:
		for (let key in this.envs) {
			let env_list = this.envs[key];
			for (let env of env_list) {
				if (envs.length === timesToInclude.size) { break search_loop; }

				if (timesToInclude.has(env['time'])) {
					envs.push(env);
				}
			}
		}

		let problem = { 'varName': varName, 'env': envs };
		const c = utils.synthesizeSnippet(JSON.stringify(problem));
		this.logger.synthStart(problem, timesToInclude.size, lineno);
		this.insertSynthesizedFragment('# Synthesizing. Please wait...', lineno);

		c.onStdout((data) => this.logger.synthOut(String(data)));
		c.onStderr((data) => this.logger.synthErr(String(data)));

		c.onExit((exitCode, result) => {
			let error: boolean = exitCode !== 0;

			if (!error) {
				this.logger.synthEnd(exitCode, result);
				error = result === undefined || result === 'None';
				if (!error) {
					this.insertSynthesizedFragment(result!!, lineno);
				}
			} else {
				this.logger.synthEnd(exitCode);
			}

			if (error) {
				this.insertSynthesizedFragment('# Synthesis failed', lineno);
			}
		});
	}

	public runProgram(e?: IModelContentChangedEvent) {

		function runImmediately(e?: IModelContentChangedEvent): boolean {
			if (e === undefined) {
				return true;
			}
			// We run immediately when any of the changes span multi-lines.
			// In this case, we will be either removing or adding projection boxes,
			// and we want to process this change immediately.
			for (let i = 0; i < e.changes.length; i++) {
				let change = e.changes[i];
				if (change.range.endLineNumber - change.range.startLineNumber > 0) {
					return true;
				}
				if (change.text.split('\n').length > 1) {
					return true;
				}
			}
			// we get here only if all changes are a single line at a time, and do not introduce new lines
			return false;
		}

		this.padBoxArray();
		this.addRemoveBoxes(e);
		this.updateMaxPixelCol();
		let delay = 500;
		if (runImmediately(e)) {
			delay = 0;
		}

		this._runProgramDelay.run(delay, () => {
			let lines = this.getModelForce().getLinesContent();
			this.removeSeeds(lines);
			const program = lines.join('\n');

			if (this._pythonProcess !== undefined) {
				this._pythonProcess.kill();
			}

			let c = utils.runProgram(program);
			this._pythonProcess = c;

			let errorMsg: string = '';
			c.onStderr((msg) => errorMsg += msg);

			c.onExit((exitCode, result) => {
				// When exitCode === null, it means the process was killed,
				// so there is nothing else to do
				if (exitCode !== null) {
					this.updateLinesWhenOutOfDate(exitCode, e);
					this._pythonProcess = undefined;
					if (exitCode === 0) {
						this.clearError();
						this.updateData(result);
						this.updateContentAndLayout();
					}
					else {
						this.showErrorWithDelay(errorMsg);
						this.updateContentAndLayout();
					}
				}
			});
		});
	}

	private updateData(str?: string) {
		try {
			// TODO better error handling instead of !!
			let data = JSON.parse(str!!);
			this.envs = data[1];
			this.writes = data[0];
		}
		catch (e) {
			console.log(str);
			console.log(e);
		}
	}

	public getEnvAtNextTimeStep(env: any): any | null {
		let result: any | null = null;
		let nextEnvs = this.envs[env.next_lineno];
		if (nextEnvs !== undefined) {
			nextEnvs.forEach((nextEnv) => {
				if (nextEnv.time === env.time + 1) {
					if (result !== null) {
						throw new Error('Should not have more than one next time step');
					}
					result = nextEnv;
				}
			});
		}
		return result;
	}

	public varRemoveInThisBox(varname: string, box: RTVDisplayBox) {
		box.varRemove(varname);
		this.updateContentAndLayout();
	}

	public varRemoveInAllBoxes(varname: string) {
		let removed = new Set<string>();
		this._boxes.forEach((box) => {
			box.varRemove(varname, removed);
		});
		removed.forEach((v) => {
			this._globalDeltaVarSet.delete(v);
		});
		this.updateContentAndLayout();
	}

	public varKeepOnlyInThisBox(varname: string, box: RTVDisplayBox) {
		box.varKeepOnly(varname);
		this.updateContentAndLayout();
	}

	public varKeepOnlyInAllBoxes(varname: string) {
		let removed = new Set<string>();
		let added = new Set<string>();
		this._boxes.forEach((box) => {
			box.varKeepOnly(varname, added, removed);
		});
		removed.forEach((v) => {
			this._globalDeltaVarSet.delete(v);
		});
		added.forEach((v) => {
			this._globalDeltaVarSet.add(v);
		});
		this.updateContentAndLayout();
	}

	public varAddInThisBox(varname: string, box: RTVDisplayBox) {
		box.varAdd(varname);
		this.updateContentAndLayout();
	}

	public varAddInAllBoxes(regExp: string) {
		let added = new Set<string>();
		this._boxes.forEach((box) => {
			box.varAdd(regExp, added);
		});
		if (!this.displayOnlyModifiedVars && (regExp === '*' || regExp === '.*')) {
			this._globalDeltaVarSet.clear();
		} else {
			added.forEach((v) => {
				this._globalDeltaVarSet.add(v);
			});
		}
		this.updateContentAndLayout();
	}

	public varAddAllInThisBox(box: RTVDisplayBox) {
		box.varAddAll();
		this.updateContentAndLayout();
	}

	public varAddAllInAllBoxes() {
		this._boxes.forEach((box) => {
			box.varAddAll();
		});
		this.updateContentAndLayout();
	}

	public hideBox(box: RTVDisplayBox) {
		this._makeNewBoxesVisible = false;
		box.varRemoveAll();
		this.updateContentAndLayout();
	}

	public hideAllOtherBoxes(box: RTVDisplayBox) {
		this._makeNewBoxesVisible = false;
		this._boxes.forEach((b) => {
			if (b !== box) {
				b.varRemoveAll();
			}
		});
		this.updateContentAndLayout();
	}

	public restoreBoxToDefault(box: RTVDisplayBox) {
		box.varRestoreToDefault();
		this.updateContentAndLayout();
	}

	public restoreAllBoxesToDefault() {
		this._makeNewBoxesVisible = true;
		this._globalDeltaVarSet.clear();
		this._boxes.forEach((box) => {
			box.varRestoreToDefault();
		});
		this.updateContentAndLayout();
	}

	public showBoxAtCurrLine() {
		this.getBoxAtCurrLine().varMakeVisible();
		this.updateContentAndLayout();
	}

	public setVisibilityAll() {
		this._visibilityPolicy = visibilityAll;
	}

	public setVisibilityNone() {
		this._visibilityPolicy = visibilityNone;
	}

	public setVisibilityCursor() {
		this._visibilityPolicy = visibilityCursor;
	}

	public setVisibilityCursorAndReturn() {
		this._visibilityPolicy = visibilityCursorAndReturn;
	}

	public flipThroughViewModes() {
		function computeNextViewMode(v: ViewMode) {
			let rs: ViewMode;

			switch (v) {
				case ViewMode.Full:
					rs = ViewMode.CursorAndReturn;
					break;
				case ViewMode.CursorAndReturn:
					rs = ViewMode.Compact;
					break;
				case ViewMode.Compact:
					rs = ViewMode.Stealth;
					break;
				case ViewMode.Stealth:
					rs = ViewMode.Full;
					break;
				default:
					rs = ViewMode.Full;
					break;
			}

			return rs;
		}

		this.changeViewMode(computeNextViewMode(this.viewMode));
	}

	public changeViewMode(m: ViewMode) {
		this.viewMode = m;
		switch (m) {
			case ViewMode.Full:
				this.setVisibilityAll();
				this.changeToFullView();
				break;
			case ViewMode.CursorAndReturn:
				this.setVisibilityCursorAndReturn();
				this.changeToFullView(1);
				break;
			case ViewMode.Compact:
				this.setVisibilityAll();
				this.changeToCompactView();
				break;
			case ViewMode.Stealth:
				this.setVisibilityNone();
				this.updateLayout();
				setTimeout(() => { this.changeToFullView(); }, 300);
				break;
			case ViewMode.Focused:
				this.setVisibilityAll();
				this.changeToFullView(1);
				break;
		}
	}

	public flipZoom() {
		if (this.zoomLevel === 0) {
			this.zoomLevel = 1;
			this.opacityLevel = 1;
		} else {
			this.zoomLevel = 0;
			this.opacityLevel = 0;
		}
		this.updateLayout();
	}


	public zoomIn() {
		if (this.byRowOrCol === RowColMode.ByCol) {
			let newZoom = this.zoomLevel + 0.1;
			if (newZoom > 1) {
				newZoom = 1;
			}
			this.zoomLevel = newZoom;
			let newOpacity = this.opacityLevel + 0.1;
			if (newOpacity > 1) {
				newOpacity = 1;
			}
			this.opacityLevel = newOpacity;
			this.updateLayout();
		}
	}

	public zoomOut() {
		if (this.byRowOrCol === RowColMode.ByCol) {
			let newZoom = this.zoomLevel - 0.1;
			if (newZoom < 0) {
				newZoom = 0;
			}
			this.zoomLevel = newZoom;
			let newOpacity = this.opacityLevel - 0.1;
			if (newOpacity < 0) {
				newOpacity = 0;
			}
			this.opacityLevel = newOpacity;
			this.updateLayout();
		}
	}

	public changeVars(op?: ChangeVarsOp, where?: ChangeVarsWhere) {
		let text: string;
		let selectionEnd: number;
		let selectionStart: number;

		if (op !== undefined && where !== undefined) {
			text = op;
			if (where === ChangeVarsWhere.All) {
				text = text + '@' + ChangeVarsWhere.All;
			}
			let varNameText = '<VarNameRegExp>';
			text = text + ' ' + varNameText;

			selectionEnd = text.length;
			selectionStart = selectionEnd - varNameText.length;
		} else {
			text = 'add|del|keep [@all] <RegExp>';
			selectionStart = 0;
			selectionEnd = text.length;
		}

		this.getUserInputAndDo(text, selectionStart, selectionEnd, (n: string) => {
			this.runChangeVarsCommand(n);
		});
	}

	private getUserInputAndDo(value: string, selectionStart: number, selectionEnd: number, onEnter: (n: string) => void) {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}

		let pixelPos = this.getLineColPixelPos(cursorPos);
		//let range = new Range(cursorPos.lineNumber-1, cursorPos.column, cursorPos.lineNumber-1, cursorPos.column + 40);

		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}

		// The following code is adapted from getDomNode in the RenameInputField class
		let domNode = document.createElement('div');

		domNode.className = 'monaco-editor rename-box';

		let input = document.createElement('input');
		input.className = 'rename-input';
		input.type = 'text';
		input.setAttribute('aria-label', localize('renameAriaLabel', 'Rename input. Type new name and press Enter to commit.'));
		domNode.appendChild(input);

		const fontInfo = this._editor.getOption(EditorOption.fontInfo);
		input.style.fontFamily = fontInfo.fontFamily;
		input.style.fontWeight = fontInfo.fontWeight;
		input.style.fontSize = `${fontInfo.fontSize}px`;
		input.value = value;
		input.selectionStart = selectionStart;
		input.selectionEnd = selectionEnd;
		input.size = value.length;

		let theme = this._themeService.getColorTheme();
		const widgetShadowColor = theme.getColor(widgetShadow);
		domNode.style.backgroundColor = String(theme.getColor(editorWidgetBackground) ?? '');
		domNode.style.boxShadow = widgetShadowColor ? ` 0 2px 8px ${widgetShadowColor}` : '';
		domNode.style.color = String(theme.getColor(inputForeground) ?? '');

		domNode.style.position = 'absolute';
		domNode.style.top = pixelPos.top + 'px';
		domNode.style.left = pixelPos.left + 'px';

		input.style.backgroundColor = String(theme.getColor(inputBackground) ?? '');
		const border = theme.getColor(inputBorder);
		input.style.borderWidth = border ? '1px' : '0px';
		input.style.borderStyle = border ? 'solid' : 'none';
		input.style.borderColor = border?.toString() ?? 'none';

		editor_div.appendChild(domNode);

		setTimeout(() => {
			input.focus();
		}, 100);

		input.onkeydown = (e) => {
			if (e.key === 'Enter') {
				onEnter(input.value);
				domNode.remove();
				setTimeout(() => {
					this._editor.focus();
				}, 100);
			} else if (e.key === 'Escape') {
				domNode.remove();
				this._editor.focus();
			}
		};

	}

	private runChangeVarsCommand(cmd: string) {
		let a = cmd.split(/[ ]+/);
		if (a.length === 2) {
			let op = a[0].trim();
			let varName = a[1].trim();
			switch (op) {
				case ChangeVarsOp.Add:
					this.varAddInThisBox(varName, this.getBoxAtCurrLine());
					break;
				case ChangeVarsOp.Add + '@' + ChangeVarsWhere.All:
					this.varAddInAllBoxes(varName);
					break;
				case ChangeVarsOp.Del:
					this.varRemoveInThisBox(varName, this.getBoxAtCurrLine());
					break;
				case ChangeVarsOp.Del + '@' + ChangeVarsWhere.All:
					this.varRemoveInAllBoxes(varName);
					break;
				case ChangeVarsOp.Keep:
					this.varKeepOnlyInThisBox(varName, this.getBoxAtCurrLine());
					break;
				case ChangeVarsOp.Keep + '@' + ChangeVarsWhere.All:
					this.varKeepOnlyInAllBoxes(varName);
					break;
			}
			//console.log(this._globalDeltaVarSet);
		}
	}

	public editingVar() {
		let d = this._editor.getPosition();
		let controller = RTVController.get(this._editor);
		let s = '';
		let line = -1;

		if (d) {
			line = d.lineNumber;
		}

		if (controller) {
			s = controller.getLineContent(line).trim();
		}

		if (line > -1) {
			this.getDictionaryMakeEdit(s, line, controller);
		}
	}

	private getDictionaryMakeEdit(s: string, line: number, controller: RTVController) {
		let listOfElems = s.split('=');

		if (listOfElems.length !== 2) {
			// TODO Can we inform the user of this?
			console.error('Invalid input format. Must be of the form <varname> = ??');
		}
		else {
			let l_operand = listOfElems[0].trim();
			let r_operand = listOfElems[1].trim();

			if (r_operand.endsWith('??')) {
				r_operand = r_operand.substr(0, r_operand.length - 2).trim();

				let model = this.getModelForce();
				let cursorPos = this._editor.getPosition();
				let startCol: number;
				let endCol: number;

				if (model.getLineContent(line).trim() === '' && cursorPos !== null && cursorPos.lineNumber === line) {
					startCol = cursorPos.column;
					endCol = cursorPos.column;
				} else {
					startCol = model.getLineFirstNonWhitespaceColumn(line);
					endCol = model.getLineMaxColumn(line);
				}

				let range = new Range(line, startCol, line, endCol);
				let txt = l_operand + ' = ' + (r_operand ? r_operand : '0');
				this._editor.executeEdits(this.getId(), [{ range: range, text: txt }]);

				setTimeout(() => {
					let cellContents = controller._boxes[line - 1].getCellContent()[l_operand];

					if (cellContents) {
						cellContents.forEach(function (cellContent) {
							cellContent.contentEditable = 'true';
						});
						cellContents[0].focus();

						// TODO Is there a faster/cleaner way to select the content?
						let selection = window.getSelection()!;
						let range = selection.getRangeAt(0)!;
						range.selectNodeContents(selection.focusNode!);
						selection.addRange(range);

						this.logger.projectionBoxFocus(s, r_operand !== '');
						this.logger.exampleFocus(0, cellContents[0]!.textContent!);
					}
				}, 300);
			}
		}

	}
	private onMouseWheel(e: IMouseWheelEvent) {
		if (this.loopFocusController !== null) {
			e.stopImmediatePropagation();
			this.scrollLoopFocusIter(e.deltaY);
		}
	}

	private onKeyUp(e: IKeyboardEvent) {
		// console.log('In controller Up:' + e.code);
		if (e.keyCode === KeyCode.Escape) {
			if (this.loopFocusController !== null) {
				e.stopPropagation();
				this.loopFocusController = null;
				this.changeViewMode(ViewMode.Full);
			}
		}
		if (e.keyCode === KeyCode.Ctrl) {
			this._peekCounter = 0;
			if (this._peekTimer !== null) {
				clearTimeout(this._peekTimer);
			}
			if (this.viewMode === ViewMode.Stealth) {
				this.setVisibilityNone();
				this.updateLayout();
			}
		}
	}

	private onKeyDown(e: IKeyboardEvent) {
		// console.log('In controller Down:' + e.code);
		if (e.keyCode === KeyCode.Ctrl) {
			this._peekCounter = this._peekCounter + 1;
			if (this._peekCounter > 1) {
				if (this._peekTimer !== null) {
					clearTimeout(this._peekTimer);
				}
				this._peekTimer = setTimeout(() => {
					this._peekTimer = null;
					this._peekCounter = 0;
					if (this.viewMode === ViewMode.Stealth) {
						this.setVisibilityNone();
						this.updateLayout();
					}
				}, 500);
				if (this._peekCounter === 2) {
					if (this.viewMode === ViewMode.Stealth) {
						this.setVisibilityCursor();
						this.updateLayout();
					}
				}
			}
		}
	}

	// Support for localized live programming

	private removeSeeds(lines: string[]) {
		if (this.loopFocusController !== null) {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].match('#@') !== null) {
					lines[i] = lines[i].replace(/#@\s*/, '');
				}
			}
		}
	}

	public scrollLoopFocusIter(deltaY: number) {
		if (this.loopFocusController !== null) {
			let iter = this.loopFocusController.iter;
			let box = this.loopFocusController.controllingBox;
			let nextIter = box.getNextLoopIter(box.getLoopID(), iter, deltaY);
			this.loopFocusController = new LoopFocusController(this, box, nextIter);
		}
	}

	private findSeed(lines: string[], currLineNumber: number) {
		let minIndent = Infinity;
		let i = currLineNumber;
		while (i >= 1) {
			let currLine = lines[i - 1];
			if (isSeedLine(currLine)) {
				if (indent(currLine) <= minIndent) {
					return i;
				}
			}
			if (isLoopStr(currLine)) {
				let currIndent = indent(currLine);
				if (currIndent < minIndent) {
					minIndent = currIndent;
				}
			}
			i = i - 1;
		}
		return 0;
	}

	public focusOnLoopWithSeed() {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}
		let lines = this.getModelForce().getLinesContent();
		let seed = this.findSeed(lines, cursorPos.lineNumber);
		if (seed === 0) {
			this.focusOnLoopAtCurrLine();
		} else {
			let seedBox = this.getBox(seed);
			this.focusOnLoopAtBox(seedBox);
		}
	}

	public focusOnLoopAtCurrLine() {
		this.focusOnLoopAtBox(this.getBoxAtCurrLine());
	}

	public focusOnLoopAtBox(box: RTVDisplayBox) {
		this.loopFocusController = new LoopFocusController(this, box, box.getFirstLoopIter());
		this.changeViewMode(ViewMode.Focused);
	}

	public executeEdits(edits: IIdentifiedSingleEditOperation[]) {
		//this.getModelForce().applyEdits(edits);
		this._editor.executeEdits(this.getId(), edits);
	}
}

registerEditorContribution(RTVController.ID, RTVController);

const boxAlignsToTopOfLineKey = 'rtv.box.alignsToTopOfLine';
const boxBorderKey = 'rtv.box.border';
const byRowOrColKey = 'rtv.box.byRowOrColumn';
const cellPaddingKey = 'rtv.box.cellPadding';
const colBorderKey = 'rtv.box.colBorder';
const displayOnlyModifiedVarsKey = 'rtv.box.displayOnlyModifiedVars';
const opacityKey = 'rtv.box.opacity';
const showBoxAtLoopStmtKey = 'rtv.box.showBoxAtLoopStatements';
const spaceBetweenBoxesKey = 'rtv.box.spaceBetweenBoxes';
const zoomKey = 'rtv.box.zoom';
const viewModeKey = 'rtv.viewMode';
const mouseShortcutsKey = 'rtv.box.mouseShortcuts';
const supportSynthesisKey = 'rtv.box.supportSynthesis';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	'id': 'rtv',
	'order': 110,
	'type': 'object',
	'title': localize('rtvConfigurationTitle', 'RTV'),
	'properties': {
		[viewModeKey]: {
			'type': 'string',
			'enum': [ViewMode.Full, ViewMode.CursorAndReturn, ViewMode.Compact, ViewMode.Stealth, ViewMode.Custom],
			'enumDescriptions': [
				localize('rtv.viewMode.full', 'All boxes are visible'),
				localize('rtv.viewMode.cursor', 'Boxes are visible at cursor and return'),
				localize('rtv.viewMode.compact', 'All boxes are visible and they are in compact view'),
				localize('rtv.viewMode.stealth', 'All boxes are invisible (hold ctrl to see box at cursor)')
			],
			'default': ViewMode.Full,
			'description': localize('rtv.viewMode', 'Allows you to choose different view modes')
		},
		[boxAlignsToTopOfLineKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.boxalignstop', 'Controls whether box aligns to top of line (true: align to top of line; false: align to middle of line )')
		},
		[boxBorderKey]: {
			'type': 'boolean',
			'default': true,
			'description': localize('rtv.boxborder', 'Controls whether boxes have a border')
		},
		[byRowOrColKey]: {
			'type': 'string',
			'enum': [RowColMode.ByCol, RowColMode.ByRow],
			'enumDescriptions': [
				localize('rtv.byRowOrColumn.byCol', 'Each column is a variable'),
				localize('rtv.byRowOrColumn.byRow', 'Each row is a variable')
			],
			'default': RowColMode.ByCol,
			'description': localize('rtv.byroworcol', 'Controls if variables are displayed in rows or columns')
		},
		[cellPaddingKey]: {
			'type': 'number',
			'default': 6,
			'description': localize('rtv.padding', 'Controls padding for each data cell')
		},
		[colBorderKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.colborder', 'Controls whether columns in box have a border')
		},
		[displayOnlyModifiedVarsKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.modvarsonly', 'Controls whether only modified vars are shown (true: display only mod vars; false: display all vars)')
		},
		[opacityKey]: {
			'type': 'number',
			'default': 0,
			'description': localize('rtv.opacity', 'Controls opacity level (value between 0 and 1; 0: see-through; 1: no see-through)')
		},
		[showBoxAtLoopStmtKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.showboxatloop', 'Controls whether boxes are displayed at loop statements')
		},
		[spaceBetweenBoxesKey]: {
			'type': 'number',
			'default': 20,
			'description': localize('rtv.boxspace', 'Controls spacing between boxes')
		},
		[zoomKey]: {
			'type': 'number',
			'default': 0,
			'description': localize('rtv.zoom', 'Controls zoom level (value between 0 and 1; 0 means shrink; 1 means no shrinking)')
		},
		[mouseShortcutsKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.mouseshortcuts', 'Controls whether mouse shortcuts are added')
		},
		[supportSynthesisKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.supportsynth', 'Controls whether synthesis is supported')
		}
	}
});


class ConfigurationServiceCache {
	private _vals: { [k: string]: any; } = {};
	public onDidUserChangeConfiguration: ((e: IConfigurationChangeEvent) => void) | undefined = undefined;
	constructor(private readonly configurationService: IConfigurationService) {
		this.configurationService.onDidChangeConfiguration((e) => { this.onChangeConfiguration(e); });
	}

	public getValue<T>(key: string): T {
		let result = this._vals[key];
		if (result === undefined) {
			result = this.configurationService.getValue(key);
			this._vals[key] = result;
		}
		return result;
	}

	public updateValue(key: string, value: any) {
		this._vals[key] = value;
		this.configurationService.updateValue(key, value);
	}

	private onChangeConfiguration(e: IConfigurationChangeEvent) {
		e.affectedKeys.forEach((key: string) => {
			if (strings.startsWith(key, 'rtv')) {
				let v = this.configurationService.getValue(key);
				if (v !== this._vals[key]) {
					this._vals[key] = v;
					if (this.onDidUserChangeConfiguration !== undefined) {
						this.onDidUserChangeConfiguration(e);
					}
				}
			}
		});
	}
}

function createRTVAction(id: string, name: string, key: number, label: string, callback: (c: RTVController) => void) {
	class RTVAction extends EditorAction {
		private _callback: (c: RTVController) => void;
		constructor() {
			super({
				id: id,
				// eslint complains that we shouldn't call `localize` with a non-literal argument.
				// eslint-disable-next-line code-no-unexternalized-strings
				label: label,
				alias: name,
				precondition: undefined,
				// menuOpts: {
				// 	menuId: MenuId.GlobalActivity,
				// 	group: 'navigation',
				// 	order: 1,
				// 	title: localize('rtv.blerg', 'Blerg'),
				// },
				kbOpts: {
					kbExpr: null,
					primary: key,
					weight: KeybindingWeight.EditorCore
				}
			});
			this._callback = callback;
		}
		public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
			let controller = RTVController.get(editor);
			if (controller) {
				this._callback(controller);
			}
		}
	}

	registerEditorAction(RTVAction);
}

// Another way to register keyboard shortcuts. Not sure which is best.
// function registerKeyShortcut(id: string, key: number, callback: (c:RTVController) => void) {
// 	KeybindingsRegistry.registerCommandAndKeybindingRule({
// 		id: id,
// 		weight: KeybindingWeight.EditorCore,
// 		when: undefined,
// 		primary: key,
// 		handler: (accessor, args: any) => {
// 			const codeEditorService = accessor.get(ICodeEditorService);

// 			// Find the editor with text focus or active
// 			const editor = codeEditorService.getFocusedCodeEditor() || codeEditorService.getActiveCodeEditor();
// 			if (!editor) {
// 				return;
// 			}
// 			let controller = RTVController.get(editor);
// 			if (controller) {
// 				callback(controller);
// 			}
// 		}
// 	});
// }

createRTVAction(
	'rtv.flipview',
	'Flip View Mode',
	KeyMod.Alt | KeyCode.Enter,
	localize('rtv.flipview', 'Flip View Mode'),
	(c) => {
		c.flipThroughViewModes();
	}
);

createRTVAction(
	'rtv.fullview',
	'Full View',
	KeyMod.Alt | KeyCode.KEY_1,
	localize('rtv.fullview', 'Full View'),
	(c) => {
		c.changeViewMode(ViewMode.Full);
	}
);

createRTVAction(
	'rtv.cursorview',
	'Cursor and Return View',
	KeyMod.Alt | KeyCode.KEY_2,
	localize('rtv.cursorview', 'Cursor and Return View'),
	(c) => {
		c.changeViewMode(ViewMode.CursorAndReturn);
	}
);

createRTVAction(
	'rtv.compactview',
	'Compact View',
	KeyMod.Alt | KeyCode.KEY_3,
	localize('rtv.compactview', 'Compact View'),
	(c) => {
		c.changeViewMode(ViewMode.Compact);
	}
);

createRTVAction(
	'rtv.stealthview',
	'Stealth View',
	KeyMod.Alt | KeyCode.KEY_4,
	localize('rtv.stealthview', 'Stealth View'),
	(c) => {
		c.changeViewMode(ViewMode.Stealth);
	}
);

createRTVAction(
	'rtv.zoomin',
	'Flip Zoom',
	KeyMod.Alt | KeyCode.US_BACKSLASH,
	localize('rtv.zoomin', 'Flip Zoom'),
	(c) => {
		c.flipZoom();
	}
);

createRTVAction(
	'rtv.changevars',
	'Add/Remove/Keep Vars',
	KeyMod.Alt | KeyCode.Backspace,
	localize('rtv.changevars', 'Add/Remove/Keep Vars'),
	(c) => {
		c.changeVars();
	}
);

createRTVAction(
	'rtv.addVarHere',
	'Add Var to This Box',
	KeyMod.Alt | KeyCode.Insert,
	localize('rtv.addVarHere', 'Add Var to This Box'),
	(c) => {
		c.changeVars(ChangeVarsOp.Add, ChangeVarsWhere.Here);
	}
);

createRTVAction(
	'rtv.addVarEverywhere',
	'Add Var to All Boxes',
	KeyMod.Alt | KeyMod.Shift | KeyCode.Insert,
	localize('rtv.addVarEverywhere', 'Add Var to All Boxes'),
	(c) => {
		c.changeVars(ChangeVarsOp.Add, ChangeVarsWhere.All);
	}
);

createRTVAction(
	'rtv.delVarHere',
	'Delete Var from This Box',
	KeyMod.Alt | KeyCode.Delete,
	localize('rtv.delVarHere', 'Delete Var from This Box'),
	(c) => {
		c.changeVars(ChangeVarsOp.Del, ChangeVarsWhere.Here);
	}
);

createRTVAction(
	'rtv.delVarEverywhere',
	'Delete Var from All Boxes',
	KeyMod.Alt | KeyMod.Shift | KeyCode.Delete,
	localize('rtv.delVarEverywhere', 'Delete Var from All Boxes'),
	(c) => {
		c.changeVars(ChangeVarsOp.Del, ChangeVarsWhere.All);
	}
);

createRTVAction(
	'rtv.keepVarHere',
	'Keep Only Var in This Box',
	KeyMod.Alt | KeyCode.End,
	localize('rtv.keepVarHere', 'Keep Only Var in This Box'),
	(c) => {
		c.changeVars(ChangeVarsOp.Keep, ChangeVarsWhere.Here);
	}
);

createRTVAction(
	'rtv.keepVarEverywhere',
	'Keep Only Var in All Boxes',
	KeyMod.Alt | KeyMod.Shift | KeyCode.End,
	localize('rtv.keepVarEverywhere', 'Keep Only Var in All Boxes'),
	(c) => {
		c.changeVars(ChangeVarsOp.Keep, ChangeVarsWhere.All);
	}
);

createRTVAction(
	'rtv.focusOnLoop',
	'Focus on Loop using Localized Live Programming',
	KeyMod.Alt | KeyCode.US_DOT,
	localize('rtv.focusOnLoop', 'Focus on Loop using Localized Live Programming'),
	(c) => {
		c.focusOnLoopWithSeed();
	}
);

// Not ready yet -- can't figure out how to make these shortcuts
// higher priority than standard VSCode shortcuts
// registerKeyShortcut(
// 	'zzzz',
// 	KeyMod.CtrlCmd | KeyCode.UpArrow,
// 	(c) => {
// 		c.scrollLoopFocusIter(-1);
// 	}
// );

// registerKeyShortcut(
// 	'rtv.ScrollLoopIterDown',
// 	KeyMod.CtrlCmd | KeyCode.DownArrow,
// 	(c) => {
// 		c.scrollLoopFocusIter(1);
// 	}
// );

createRTVAction(
	'rtv.editVar',
	'Start Editing the Var',
	KeyMod.Shift | KeyCode.Space,
	localize('rtv.editVar', 'Start Editing the Var'),
	(c) => {
		c.editingVar();
	}
);
