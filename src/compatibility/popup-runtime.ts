import './popup-runtime.css';

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 } as const;
export const POPUP_RESULT = {
    AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null,
    CUSTOM1: 1001, CUSTOM2: 1002, CUSTOM3: 1003, CUSTOM4: 1004, CUSTOM5: 1005,
    CUSTOM6: 1006, CUSTOM7: 1007, CUSTOM8: 1008, CUSTOM9: 1009,
} as const;

type Result = number | null;
type Value = Result | string | boolean;
type Content = string | Node | ArrayLike<Node> | null | undefined;
interface CustomButton {
    text: string; tooltip?: string; result?: Result; classes?: string | string[];
    icon?: string; action?: (this: HTMLElement, event: MouseEvent) => void; appendAtEnd?: boolean;
}
interface CustomInput {
    id: string; label: string; tooltip?: string; defaultState?: boolean | string;
    type?: 'checkbox' | 'text' | 'textarea' | 'number'; rows?: number; min?: number; max?: number; step?: number;
    disabled?: boolean; autoFocus?: boolean;
}
interface PopupOptions {
    okButton?: string | boolean | null; cancelButton?: string | boolean | null;
    rows?: number; placeholder?: string | null; tooltip?: string | null;
    wide?: boolean; wider?: boolean; large?: boolean; transparent?: boolean; leftAlign?: boolean;
    allowHorizontalScrolling?: boolean; allowVerticalScrolling?: boolean; animation?: 'slow' | 'fast' | 'none' | null;
    defaultResult?: Result; customButtons?: (CustomButton | string)[] | null; customInputs?: CustomInput[] | null;
    allowEscapeClose?: boolean; onClosing?: (popup: Popup) => boolean | void | Promise<boolean | void>;
    onClose?: (popup: Popup) => unknown; onOpen?: (popup: Popup) => unknown;
    cropAspect?: number | null; cropImage?: string | null;
}

export class PopupUtils {
    static BuildTextWithHeader(header?: string | null, text?: string | null) {
        return header ? `<h3>${header}</h3>\n${text ?? ''}` : text;
    }
}

const owners = new WeakMap<Popup, Window>();
const displayed: Popup[] = [];
let publishVisibility: (visible: boolean) => void = () => {};

export function getTopmostModalLayer(): HTMLElement {
    return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([closing])')].at(-1) ?? document.body;
}

export function fixToastrForDialogs(): void {
    const container = document.getElementById('toast-container');
    const layer = getTopmostModalLayer();
    if (container && container.parentElement !== layer) layer.append(container);
}

function popupButton(className: string, text: string, result: Result | undefined) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = className; button.textContent = text;
    button.dataset.result = String(result);
    button.dataset.i18n = text;
    return button;
}

function afterAnimation(element: HTMLElement, callback: () => void) {
    const animation = element.getAnimations().find(item => 'animationName' in item && String(item.animationName).startsWith('compat-popup-'));
    if (animation) void animation.finished.then(callback, callback);
    else callback();
}

export class Popup {
    static util = {
        popups: [] as Popup[],
        lastResult: null as { value: Value; result: Result; inputResults?: Map<string, string | boolean> } | null,
        isPopupOpen: () => displayed.some(popup => popup.dlg.open),
        getTopmostModalLayer,
    };

    static get show() {
        const Ctor = this;
        return {
            text: (header?: string | null, text?: string | null, options?: PopupOptions) =>
                new Ctor(PopupUtils.BuildTextWithHeader(header, text), POPUP_TYPE.TEXT, null, options).show() as Promise<Result>,
            confirm: (header?: string | null, text?: string | null, options?: PopupOptions) =>
                new Ctor(PopupUtils.BuildTextWithHeader(header, text), POPUP_TYPE.CONFIRM, null, options).show() as Promise<Result>,
            input: async (header?: string | null, text?: string | null, input = '', options?: PopupOptions) => {
                const value = await new Ctor(PopupUtils.BuildTextWithHeader(header, text), POPUP_TYPE.INPUT, input, options).show();
                return value === '' ? '' : value ? String(value) : null;
            },
        };
    }

    readonly id = crypto.randomUUID();
    readonly dlg = document.createElement('dialog');
    readonly body: HTMLDivElement;
    readonly content: HTMLDivElement;
    readonly mainInput: HTMLTextAreaElement;
    readonly inputControls: HTMLDivElement;
    readonly buttonControls: HTMLDivElement;
    readonly okButton: HTMLButtonElement;
    readonly cancelButton: HTMLButtonElement;
    readonly closeButton: HTMLButtonElement;
    readonly cropWrap: HTMLDivElement;
    readonly cropImage: HTMLImageElement;
    readonly defaultResult: Result;
    readonly customInputs: PopupOptions['customInputs'];
    readonly customButtons: PopupOptions['customButtons'];
    onOpen: PopupOptions['onOpen'];
    onClosing: PopupOptions['onClosing'];
    onClose: PopupOptions['onClose'];
    result?: Result;
    value?: Value;
    inputResults?: Map<string, string | boolean>;
    lastFocus?: HTMLElement;
    cropData?: Cropper.Data & { want_resize: boolean };
    #cropper?: Cropper;
    #promise?: Promise<Value>;
    #resolve?: (value: Value) => void;
    #closing = false;
    #finished = false;
    #lastEscape = -Infinity;
    #forceClose?: Popup;
    #inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();

    constructor(content: Content, readonly type: number, inputValue: string | null = '', private readonly options: PopupOptions = {}) {
        const { okButton, cancelButton, customInputs = null, customButtons = null } = options;
        this.defaultResult = options.defaultResult === undefined ? POPUP_RESULT.AFFIRMATIVE : options.defaultResult;
        this.customButtons = customButtons; this.customInputs = customInputs;
        this.onOpen = options.onOpen; this.onClose = options.onClose; this.onClosing = options.onClosing;

        this.dlg.className = 'popup tipsy-compat-popup';
        this.dlg.dataset.id = this.id;
        const classes = {
            wide: 'wide_dialogue_popup', wider: 'wider_dialogue_popup', large: 'large_dialogue_popup',
            transparent: 'transparent_dialogue_popup', allowHorizontalScrolling: 'horizontal_scrolling_dialogue_popup',
            allowVerticalScrolling: 'vertical_scrolling_dialogue_popup', leftAlign: 'left_aligned_dialogue_popup',
        } as const;
        for (const key of Object.keys(classes) as Array<keyof typeof classes>) if (options[key]) this.dlg.classList.add(classes[key]);
        if (options.animation !== null) this.dlg.classList.add(`popup--animation-${options.animation ?? 'fast'}`);
        this.dlg.innerHTML = `<div class="popup-body"><div class="popup-content"></div><div class="popup-crop-wrap"><img class="popup-crop-image" alt=""></div><textarea class="popup-input text_pole result-control auto-select" data-result="1" data-result-event="submit"></textarea><div class="popup-inputs"></div><div class="popup-controls"></div></div>`;
        this.body = this.dlg.querySelector('.popup-body')!;
        this.content = this.dlg.querySelector('.popup-content')!;
        this.cropWrap = this.dlg.querySelector('.popup-crop-wrap')!;
        this.cropImage = this.dlg.querySelector('.popup-crop-image')!;
        this.mainInput = this.dlg.querySelector('.popup-input')!;
        this.inputControls = this.dlg.querySelector('.popup-inputs')!;
        this.buttonControls = this.dlg.querySelector('.popup-controls')!;

        const showCancel = typeof cancelButton === 'string' || (type === POPUP_TYPE.TEXT ? cancelButton === true : cancelButton !== false);
        const ok = typeof okButton === 'string' ? okButton : okButton === true ? 'OK' :
            type === POPUP_TYPE.CONFIRM ? '是' : type === POPUP_TYPE.INPUT ? '保存' : type === POPUP_TYPE.CROP ? '裁剪' : '确定';
        const cancel = typeof cancelButton === 'string' ? cancelButton : type === POPUP_TYPE.CONFIRM && !cancelButton ? '否' : '取消';
        this.okButton = popupButton('popup-button-ok menu_button result-control', ok, POPUP_RESULT.AFFIRMATIVE);
        this.cancelButton = popupButton('popup-button-cancel menu_button result-control', cancel, POPUP_RESULT.NEGATIVE);
        this.closeButton = popupButton('popup-button-close right_menu_button fa-solid fa-circle-xmark', '', POPUP_RESULT.NEGATIVE);
        this.closeButton.title = '关闭弹窗'; this.closeButton.setAttribute('aria-label', this.closeButton.title);
        this.closeButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
        this.okButton.hidden = okButton === false;
        this.cancelButton.hidden = !showCancel;
        this.closeButton.hidden = type !== POPUP_TYPE.DISPLAY;
        this.buttonControls.hidden = type === POPUP_TYPE.DISPLAY;
        this.mainInput.hidden = type !== POPUP_TYPE.INPUT;
        this.cropWrap.hidden = type !== POPUP_TYPE.CROP;
        this.mainInput.rows = options.rows ?? 1;
        this.mainInput.value = inputValue ?? '';
        this.mainInput.placeholder = options.placeholder ?? '';
        this.mainInput.setAttribute('aria-label', '输入内容');
        if (options.tooltip) (type === POPUP_TYPE.INPUT ? this.mainInput : this.content).title = options.tooltip;
        this.buttonControls.append(this.okButton, this.cancelButton);
        this.dlg.append(this.closeButton);

        if (typeof content === 'string') this.content.innerHTML = content;
        else if (content && 'nodeType' in content) this.content.append(content);
        else if (content) this.content.append(...Array.from(content));
        const heading = this.content.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6');
        if (heading) { heading.id ||= `popup-title-${this.id}`; this.dlg.setAttribute('aria-labelledby', heading.id); }
        else this.dlg.setAttribute('aria-label', '弹窗');

        customInputs?.forEach(input => this.#addInput(input));
        this.inputControls.hidden = !this.inputControls.childElementCount;
        customButtons?.forEach((entry, index) => this.#addButton(typeof entry === 'string' ? { text: entry, result: index + 2 } : entry));
        this.buttonControls.querySelector(`[data-result="${this.defaultResult}"]`)?.classList.add('menu_button_default');
        this.setAutoFocus({ applyAutoFocus: true });

        for (const control of this.dlg.querySelectorAll<HTMLElement>('[data-result]')) {
            const value = control.dataset.result;
            if (value === 'undefined') continue;
            const result = value === 'null' ? null : Number(value);
            if (Number.isNaN(result)) throw new Error(`Invalid result control. Result must be a number. ${value}`);
            control.addEventListener(control.dataset.resultEvent || 'click', () => { void this.complete(result); });
        }
        this.dlg.addEventListener('focusin', event => {
            if (event.target instanceof HTMLElement && event.target !== this.dlg) this.lastFocus = event.target;
        });
        this.dlg.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.altKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
            const control = (event.target as HTMLElement).closest<HTMLElement>('.result-control');
            // Real buttons already receive keyboard activation, including custom actions.
            if (!control || control.tagName === 'BUTTON' || control.tagName === 'TEXTAREA' && this.mainInput.rows > 1 && !event.ctrlKey) return;
            event.preventDefault(); event.stopPropagation();
            const value = control.dataset.result;
            if (value !== 'undefined') void this.complete(value === 'null' ? null : value === undefined ? this.defaultResult : Number(value));
        });
        this.dlg.addEventListener('cancel', event => {
            event.preventDefault(); event.stopPropagation();
            if (this.options.allowEscapeClose !== false) { void this.completeCancelled(); return; }
            const now = performance.now();
            if (now - this.#lastEscape < 500 && !this.#forceClose) queueMicrotask(() => { void this.#confirmForceClose(); });
            this.#lastEscape = now;
        });
        this.dlg.addEventListener('close', () => {
            if (!this.#closing && !this.#finished) void this.completeCancelled().then(() => {
                if (!this.#finished && !this.dlg.open) this.dlg.showModal();
            });
        });
        Popup.util.popups.push(this);
    }

    #addButton({ text, tooltip, result, classes, icon, action, appendAtEnd }: CustomButton) {
        const button = popupButton('popup-button-custom menu_button result-control', text, result);
        button.classList.add(...(Array.isArray(classes) ? classes : (classes ?? '').split(/\s+/)).filter(Boolean));
        if (icon) {
            const symbol = document.createElement('i'); symbol.className = `fa-solid ${icon}`; symbol.setAttribute('aria-hidden', 'true');
            button.classList.add('menu_button_icon'); button.prepend(symbol);
        }
        if (tooltip) button.title = tooltip;
        if (action) button.addEventListener('click', action);
        this.buttonControls.insertBefore(button, appendAtEnd ? null : this.okButton);
    }

    #addInput(input: CustomInput) {
        if (!input.id) return;
        const type = input.type ?? 'checkbox';
        if (!['checkbox', 'text', 'textarea', 'number'].includes(type)) return;
        const label = document.createElement('label'); label.htmlFor = input.id;
        label.className = `${type === 'checkbox' ? 'checkbox' : 'text'}_label justifyCenter`;
        const caption = document.createElement('span'); caption.textContent = input.label;
        const control = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
        control.id = input.id; control.disabled = !!input.disabled; control.autofocus = !!input.autoFocus;
        if (control instanceof HTMLInputElement) control.type = type;
        if (type === 'checkbox') (control as HTMLInputElement).checked = Boolean(input.defaultState);
        else {
            control.className = 'text_pole result-control';
            control.placeholder = input.tooltip ?? ''; control.value = String(input.defaultState ?? '');
            if (control instanceof HTMLTextAreaElement) control.rows = input.rows ?? 1;
            else if (type === 'number') {
                for (const key of ['min', 'max', 'step'] as const) control[key] = input[key] === undefined ? '' : String(input[key]);
                control.addEventListener('change', () => {
                    if (!Number.isFinite(control.valueAsNumber)) return;
                    control.valueAsNumber = Math.min(input.max ?? Infinity, Math.max(input.min ?? -Infinity, control.valueAsNumber));
                });
            }
        }
        if (input.tooltip) label.title = input.tooltip;
        if (type === 'checkbox') label.append(control, caption); else label.append(caption, control);
        this.#inputs.set(input.id, control); this.inputControls.append(label);
    }

    setAutoFocus({ applyAutoFocus = false } = {}) {
        const control = this.dlg.querySelector<HTMLElement>('[autofocus]:not(:disabled)') ??
            (this.type === POPUP_TYPE.INPUT ? this.mainInput : this.buttonControls.querySelector<HTMLElement>(`[data-result="${this.defaultResult}"]:not([hidden])`)) ??
            (this.type === POPUP_TYPE.DISPLAY ? this.closeButton : undefined);
        if (applyAutoFocus) control?.setAttribute('autofocus', '');
        else (control ?? this.dlg).focus();
    }

    show(): Promise<Value> {
        if (this.#promise) return this.#promise;
        if (this.#finished) return Promise.resolve(POPUP_RESULT.CANCELLED);
        this.#promise = new Promise(resolve => { this.#resolve = resolve; });
        document.body.append(this.dlg);
        this.dlg.setAttribute('opening', '');
        this.dlg.showModal();
        displayed.push(this);
        if (displayed.length === 1) publishVisibility(true);
        fixToastrForDialogs();
        if (this.type === POPUP_TYPE.CROP && this.options.cropImage) void this.#loadCropper().catch(error => {
            if (this.#finished) return;
            console.error('Popup image crop failed', error);
            void this.completeCancelled();
        });
        afterAnimation(this.dlg, () => {
            this.dlg.removeAttribute('opening');
            if (!this.#finished && !this.#closing) void this.onOpen?.(this);
        });
        return this.#promise;
    }

    async #loadCropper() {
        this.okButton.disabled = true;
        const [{ default: Cropper }] = await Promise.all([import('cropperjs'), import('cropperjs/dist/cropper.css')]);
        if (this.#finished || this.#closing) return;
        this.cropImage.src = this.options.cropImage!;
        this.#cropper = new Cropper(this.cropImage, {
            aspectRatio: this.options.cropAspect ?? 2 / 3, autoCropArea: 1, viewMode: 2, rotatable: false,
            ready: () => { this.okButton.disabled = false; },
            crop: event => { this.cropData = { ...event.detail, want_resize: true }; },
        });
    }

    async #confirmForceClose() {
        if (this.#finished || this.#forceClose) return;
        const confirm = this.#forceClose = new Popup(PopupUtils.BuildTextWithHeader('强制关闭弹窗？', '<p>此操作尚未完成。</p>'),
            POPUP_TYPE.CONFIRM, '', { okButton: '强制关闭', cancelButton: '取消' });
        const result = await confirm.show();
        this.#forceClose = undefined;
        if (result === POPUP_RESULT.AFFIRMATIVE && this.dlg.open) await this.completeCancelled();
    }

    async complete(result: Result): Promise<Value | undefined> {
        if (this.#closing || this.#finished) return undefined;
        let value: Value = result;
        if (this.type === POPUP_TYPE.INPUT) value = result === null ? null : result >= 1 ? this.mainInput.value : false;
        if (this.type === POPUP_TYPE.CROP) {
            if (result !== null && result >= 1 && this.okButton.disabled) return undefined;
            value = result !== null && result >= 1 ? this.#cropper?.getCroppedCanvas()?.toDataURL('image/jpeg') ?? null : null;
        }
        this.#closing = true;
        this.result = result; this.value = value;
        this.inputResults = this.#inputs.size ? new Map([...this.#inputs].map(([id, control]) => [id,
            control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value])) : undefined;
        try {
            if (this.onClosing && !await this.onClosing(this)) {
                if (!this.#finished) { this.#closing = false; this.result = this.value = this.inputResults = undefined; }
                return undefined;
            }
        } catch (error) { this.#closing = false; throw error; }
        if (this.#finished) return this.value;
        Popup.util.lastResult = { value, result, inputResults: this.inputResults };
        this.dlg.setAttribute('closing', '');
        fixToastrForDialogs();
        await new Promise<void>(resolve => afterAnimation(this.dlg, resolve));
        if (this.#finished) return this.value;
        this.dlg.close();
        try { await this.onClose?.(this); }
        finally { this.#remove(value); }
        return this.#promise ?? value;
    }

    completeAffirmative() { return this.complete(POPUP_RESULT.AFFIRMATIVE); }
    completeNegative() { return this.complete(POPUP_RESULT.NEGATIVE); }
    completeCancelled() { return this.complete(POPUP_RESULT.CANCELLED); }

    /** Session and iframe teardown must settle author awaits even if onClosing vetoes. */
    dispose() {
        if (this.#finished) return;
        this.result = this.value = POPUP_RESULT.CANCELLED;
        this.#remove(POPUP_RESULT.CANCELLED);
    }

    #remove(value: Value) {
        if (this.#finished) return;
        this.#finished = true;
        this.#forceClose?.dispose();
        this.#cropper?.destroy();
        if (this.dlg.open) this.dlg.close();
        this.dlg.remove();
        const index = Popup.util.popups.indexOf(this);
        if (index >= 0) Popup.util.popups.splice(index, 1);
        const displayIndex = displayed.indexOf(this);
        if (displayIndex >= 0) {
            displayed.splice(displayIndex, 1);
            if (!displayed.length) publishVisibility(false);
            else if (displayIndex === displayed.length) focusPopup();
        }
        fixToastrForDialogs();
        this.#resolve?.(value);
    }
}

export function focusPopup() {
    const popup = displayed.at(-1);
    if (!popup?.dlg.open || popup.dlg.contains(document.activeElement)) return;
    if (popup.lastFocus?.isConnected) popup.lastFocus.focus(); else popup.setAutoFocus();
}

export function disposePopups(owner?: Window) {
    for (const popup of [...Popup.util.popups].reverse()) if (!owner || owners.get(popup) === owner) popup.dispose();
}

export function onPopupVisibility(callback: typeof publishVisibility) { publishVisibility = callback; }

export function popupApi(owner?: Window) {
    const OwnedPopup = owner ? class PopupForAuthor extends Popup {
        constructor(...args: ConstructorParameters<typeof Popup>) { super(...args); owners.set(this, owner!); }
    } : Popup;
    const callGenericPopup = (...args: ConstructorParameters<typeof Popup>) => new OwnedPopup(...args).show();
    const callPopup = async (content: Content, type = 'text', inputValue = '', options: PopupOptions = {}) => {
        const textOnly = type === 'text' || type === 'char_not_selected';
        const mode = type === 'input' ? POPUP_TYPE.INPUT : textOnly ? POPUP_TYPE.TEXT : POPUP_TYPE.CONFIRM;
        const defaultLabel = type === 'new_chat' || type === 'confirm' ? '是' : type === 'input' ? '保存' :
            textOnly || type === 'delete_extension' ? '确定' : '删除';
        const value = await callGenericPopup(content, mode, inputValue, { ...options, okButton: options.okButton ?? defaultLabel,
            cancelButton: options.cancelButton ?? (textOnly ? false : '取消') });
        return mode === POPUP_TYPE.INPUT ? (typeof value === 'string' ? value : false) : value === POPUP_RESULT.AFFIRMATIVE;
    };
    return { Popup: OwnedPopup, PopupUtils, POPUP_TYPE, POPUP_RESULT, callGenericPopup, callPopup, getTopmostModalLayer, fixToastrForDialogs };
}
