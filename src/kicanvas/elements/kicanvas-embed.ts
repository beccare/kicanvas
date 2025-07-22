/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { later } from "../../base/async";
import { BBox, Matrix3 } from "../../base/math";
import { Color } from "../../base/color";
import {
    CSS,
    CustomElement,
    attribute,
    css,
    html,
} from "../../base/web-components";
import { KCUIElement } from "../../kc-ui";
import kc_ui_styles from "../../kc-ui/kc-ui.css";
import { Project } from "../project";
import { FetchFileSystem, VirtualFileSystem } from "../services/vfs";
import { LibSymbol } from "../../kicad/schematic";
import { Canvas2DRenderer } from "../../graphics/canvas2d";
import { SchematicPainter } from "../../viewers/schematic/painter";
import { LayerSet, LayerNames } from "../../viewers/schematic/layers";
import type { SchematicTheme } from "../../kicad";
import type { KCBoardAppElement } from "./kc-board/app";
import type { KCSchematicAppElement } from "./kc-schematic/app";

/**
 *
 */
class KiCanvasEmbedElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        new CSS(kc_ui_styles),
        css`
            :host {
                margin: 0;
                display: flex;
                position: relative;
                width: 100%;
                max-height: 100%;
                aspect-ratio: 1.414;
                background-color: #f0f0f0;
                color: var(--fg);
                font-family: "Nunito", ui-rounded, "Hiragino Maru Gothic ProN",
                    Quicksand, Comfortaa, Manjari, "Arial Rounded MT Bold",
                    Calibri, source-sans-pro, sans-serif;
                contain: layout paint;
            }

            main {
                display: contents;
            }

            kc-board-app,
            kc-schematic-app {
                width: 100%;
                height: 100%;
                flex: 1;
            }
        `,
    ];

    constructor() {
        super();
        this.provideContext("project", this.#project);
    }

    #project: Project = new Project();
    #inline_symbol: LibSymbol | null = null;

    @attribute({ type: String })
    src: string | null;

    @attribute({ type: Boolean })
    public loading: boolean;

    @attribute({ type: Boolean })
    public loaded: boolean;

    @attribute({ type: String })
    controls: "none" | "basic" | "full" | null;

    @attribute({ type: String })
    controlslist: string | null;

    @attribute({ type: String })
    theme: string | null;

    @attribute({ type: String })
    zoom: "objects" | "page" | string | null;

    custom_resolver: ((name: string) => URL) | null = null;

    #schematic_app: KCSchematicAppElement;
    #board_app: KCBoardAppElement;

    override initialContentCallback() {
        this.#setup_events();
        later(() => {
            this.#load_src();
        });
    }

    async #setup_events() {}

    async #load_src() {
        const sources = [];
        let inline_symbol_data: string | null = null;

        if (this.src) {
            sources.push(this.src);
        }

        for (const src_elm of this.querySelectorAll<KiCanvasSourceElement>(
            "kicanvas-source",
        )) {
            if (src_elm.src) {
                sources.push(src_elm.src);
            } else if (src_elm.type === "schematic" && src_elm.textContent?.trim()) {
                const content = src_elm.textContent.trim();
                // Check for inline lib_symbols data
                if (content.includes("lib_symbols") && content.includes("symbol")) {
                    inline_symbol_data = content;
                }
            }
        }

        if (inline_symbol_data) {
            await this.#setup_inline_symbol(inline_symbol_data);
        } else if (sources.length > 0) {
            const vfs = new FetchFileSystem(sources, this.custom_resolver);
            await this.#setup_project(vfs);
        } else {
            console.warn("No valid sources specified");
        }
    }

    async #setup_inline_symbol(symbol_data: string) {
        console.log("Setting up inline symbol with data:", symbol_data.substring(0, 100) + "...");
        this.loaded = false;
        this.loading = true;

        try {
            // Create a minimal schematic context for symbol parsing
            const mock_schematic = {
                filename: "inline-symbol",
                resolve_text_var: () => undefined,
            };

            // Extract individual symbol from lib_symbols wrapper if present
            let symbolExpr: any = symbol_data.trim();
            if (symbolExpr.includes("lib_symbols")) {
                console.log("Found lib_symbols wrapper, extracting symbol...");
                try {
                    // Parse the lib_symbols to extract the first symbol
                    const { listify } = await import("../../kicad/tokenizer");
                    const parsed = listify(symbolExpr);
                    
                    // Find the lib_symbols section and extract the first symbol
                    for (const item of parsed) {
                        if (Array.isArray(item) && (item as any[])[0] === "lib_symbols") {
                            // Look for symbol within lib_symbols
                            for (let i = 1; i < (item as any[]).length; i++) {
                                const subItem = (item as any[])[i];
                                if (Array.isArray(subItem) && subItem[0] === "symbol") {
                                    // Filter out unsupported properties from the parsed array
                                    symbolExpr = this.#filterUnsupportedSymbolProperties(subItem);
                                    console.log("Extracted symbol expression:", symbolExpr);
                                    break;
                                }
                            }
                            break;
                        }
                    }
                } catch (error) {
                    console.warn("Failed to parse lib_symbols, using raw data:", error);
                }
            }

            console.log("Creating LibSymbol with expression...");
            this.#inline_symbol = new LibSymbol(symbolExpr, mock_schematic as any);
            console.log("LibSymbol created successfully:", this.#inline_symbol);
            console.log("Inline symbol stored, checking:", !!this.#inline_symbol);
            
            this.loaded = true;
            console.log("About to call update(), loaded =", this.loaded);
            await this.update();
            console.log("Update complete, inline_symbol still exists:", !!this.#inline_symbol);
        } catch (error) {
            console.error("Failed to setup inline symbol:", error);
        } finally {
            this.loading = false;
        }
    }

    async #setup_project(vfs: VirtualFileSystem) {
        this.loaded = false;
        this.loading = true;

        try {
            await this.#project.load(vfs);

            this.loaded = true;
            await this.update();

            this.#project.set_active_page(this.#project.root_schematic_page!);
        } finally {
            this.loading = false;
        }
    }

    override render() {
        if (!this.loaded) {
            return html``;
        }

        // Render inline symbol directly
        if (this.#inline_symbol) {
            return html`<canvas style="width: 100%; height: 100%; display: block; border: 1px solid red;"></canvas>`;
        }

        if (this.#project.has_schematics && !this.#schematic_app) {
            this.#schematic_app = html`<kc-schematic-app
                sidebarcollapsed
                controls="${this.controls}"
                controlslist="${this.controlslist}">
            </kc-schematic-app>` as KCSchematicAppElement;
        }

        if (this.#project.has_boards && !this.#board_app) {
            this.#board_app = html`<kc-board-app
                sidebarcollapsed
                controls="${this.controls}"
                controlslist="${this.controlslist}">
            </kc-board-app>` as KCBoardAppElement;
        }

        const focus_overlay =
            (this.controls ?? "none") == "none" ||
            this.controlslist?.includes("nooverlay")
                ? null
                : html`<kc-ui-focus-overlay></kc-ui-focus-overlay>`;

        return html`<main>
            ${this.#schematic_app} ${this.#board_app} ${focus_overlay}
        </main>`;
    }

    override renderedCallback() {
        console.log("renderedCallback called, inline_symbol exists:", !!this.#inline_symbol, "loaded:", this.loaded);
        
        // Only render if we have a symbol and are loaded
        if (!this.#inline_symbol || !this.loaded) {
            console.warn("Not ready to render - symbol:", !!this.#inline_symbol, "loaded:", this.loaded);
            return;
        }
        
        const canvas = this.renderRoot.querySelector("canvas") as HTMLCanvasElement;
        console.log("Canvas found:", canvas);
        console.log("Canvas style:", canvas.style.cssText);
        console.log("Canvas computed style width/height:", 
            window.getComputedStyle(canvas).width, 
            window.getComputedStyle(canvas).height);
        if (canvas) {
            console.log("Canvas dimensions:", canvas.width, "x", canvas.height);
            console.log("Canvas client dimensions:", canvas.clientWidth, "x", canvas.clientHeight);
            console.log("Canvas offset dimensions:", canvas.offsetWidth, "x", canvas.offsetHeight);
            // Defer async rendering to avoid callback type mismatch
            later(async () => {
                console.log("Starting canvas rendering with symbol:", !!this.#inline_symbol);
                await this.#render_symbol_to_canvas(canvas);
            });
        } else {
            console.warn("No canvas found in renderRoot");
        }
    }

    async #render_symbol_to_canvas(canvas: HTMLCanvasElement) {
        console.log("render_symbol_to_canvas called with canvas:", canvas);
        if (!this.#inline_symbol) {
            console.warn("No inline symbol available");
            return;
        }

        console.log("Inline symbol available:", this.#inline_symbol);

        // Set canvas size based on container
        const rect = this.getBoundingClientRect();
        canvas.width = rect.width || 300;
        canvas.height = rect.height || 200;
        console.log("Canvas size set to:", canvas.width, "x", canvas.height);

        // Create renderer and painter
        const renderer = new Canvas2DRenderer(canvas);
        await renderer.setup();
        console.log("Renderer setup complete, ctx2d:", !!renderer.ctx2d);
        
        // Ensure renderer is properly initialized before proceeding
        if (!renderer.ctx2d) {
            console.warn("Canvas2D renderer not properly initialized");
            return;
        }
        
        const mockTheme: SchematicTheme = {
            background: new Color(0.94, 0.94, 0.94, 1),
            note: new Color(0, 0, 0, 1),
            pin: new Color(0.8, 0, 0, 1),
            pin_name: new Color(0, 0.6, 0.6, 1),
            pin_number: new Color(0.8, 0, 0, 1),
            component_outline: new Color(0.8, 0, 0, 1),
            component_body: new Color(1, 1, 0.8, 1),
            // Add other required theme properties with default colors
            anchor: new Color(0, 0, 1, 1),
            aux_items: new Color(0.5, 0.5, 0.5, 1),
            brightened: new Color(1, 1, 0, 1),
            bus: new Color(0, 0, 1, 1),
            bus_junction: new Color(0, 0, 1, 1),
            cursor: new Color(1, 0, 0, 1),
            erc_error: new Color(1, 0, 0, 1),
            erc_warning: new Color(1, 0.5, 0, 1),
            fields: new Color(0.5, 0, 0.5, 1),
            hidden: new Color(0.7, 0.7, 0.7, 1),
            junction: new Color(0, 0.8, 0, 1),
            label_global: new Color(1, 0.5, 0, 1),
            label_hier: new Color(0.8, 0.4, 0, 1),
            label_local: new Color(0, 0, 0, 1),
            no_connect: new Color(0, 0, 1, 1),
            reference: new Color(0, 0.6, 0.6, 1),
            shadow: new Color(0.3, 0.3, 0.3, 1),
            sheet: new Color(0.5, 0, 0.5, 1),
        } as SchematicTheme;
        
        const layers = new LayerSet(mockTheme);
        const painter = new SchematicPainter(renderer, layers, mockTheme);

        // Calculate symbol bounds and center it
        const symbol_bbox = this.#calculate_symbol_bbox(this.#inline_symbol);
        console.log("Symbol bbox:", symbol_bbox);
        
        const padding = 20;
        const scale = Math.min(
            (canvas.width - padding * 2) / symbol_bbox.w,
            (canvas.height - padding * 2) / symbol_bbox.h
        );
        console.log("Calculated scale:", scale, "canvas size:", canvas.width, "x", canvas.height);

        // Set up camera transform
        const center_x = canvas.width / 2;
        const center_y = canvas.height / 2;
        const symbol_center_x = symbol_bbox.x + symbol_bbox.w / 2;
        const symbol_center_y = symbol_bbox.y + symbol_bbox.h / 2;
        console.log("Centers - canvas:", center_x, center_y, "symbol:", symbol_center_x, symbol_center_y);
        
        // Set up canvas and transformation
        if (!renderer.ctx2d) return;
        
        renderer.ctx2d.save();
        renderer.ctx2d.translate(center_x, center_y);
        renderer.ctx2d.scale(scale, -scale); // Flip Y axis for KiCad coordinates
        renderer.ctx2d.translate(-symbol_center_x, -symbol_center_y);

        // Paint the symbol on relevant layers - simplified approach
        try {
            // Clear and prepare canvas - MOVED TO BEFORE TEST DRAWINGS
            renderer.clear_canvas();
            
            // Test drawing AFTER clearing but BEFORE layer rendering
            console.log("Drawing test squares after clearing...");
            renderer.ctx2d.fillStyle = "#ff0000";
            renderer.ctx2d.fillRect(10, 10, 50, 50);
            renderer.ctx2d.fillStyle = "#0000ff";
            renderer.ctx2d.fillRect(70, 10, 50, 50);
            console.log("Test squares drawn after clear");
            
            // Paint directly to layers without trying to render them manually
            const symbol_layers = [
                layers.by_name(LayerNames.symbol_background),
                layers.by_name(LayerNames.symbol_foreground), 
                layers.by_name(LayerNames.symbol_pin),
            ];
            
            for (const layer of symbol_layers) {
                if (layer) {
                    console.log("Processing layer:", layer.name);
                    // Start a layer for each symbol layer
                    renderer.start_layer(layer.name);
                    console.log("Started layer, about to paint item");
                    painter.paint_item(layer, this.#inline_symbol);
                    console.log("Paint item complete, ending layer");
                    layer.graphics = renderer.end_layer();
                    console.log("Layer graphics created:", !!layer.graphics);
                }
            }
            
            // Render the painted layers to the canvas
            const currentTransform = renderer.ctx2d.getTransform();
            const kicanvasMatrix = Matrix3.from_DOMMatrix(currentTransform);
            console.log("Transformation matrix elements:", Array.from(kicanvasMatrix.elements));
            console.log("Matrix: a=", currentTransform.a, "b=", currentTransform.b, "c=", currentTransform.c, "d=", currentTransform.d, "e=", currentTransform.e, "f=", currentTransform.f);
            console.log("About to render", symbol_layers.length, "layers to canvas with matrix:", kicanvasMatrix);
            for (const layer of symbol_layers) {
                if (layer && layer.graphics) {
                    console.log("Rendering layer:", layer.name, "with graphics");
                    layer.graphics.render(kicanvasMatrix, 1.0, 1.0);
                } else {
                    console.log("Skipping layer:", layer?.name, "graphics exists:", !!layer?.graphics);
                }
            }
            console.log("Layer rendering complete");
            
            // Draw test squares AFTER layer rendering to ensure they stay visible
            console.log("Drawing final test squares...");
            renderer.ctx2d.fillStyle = "#00ff00"; // Green squares this time
            renderer.ctx2d.fillRect(130, 50, 30, 30);
            renderer.ctx2d.fillStyle = "#ff00ff"; // Magenta square
            renderer.ctx2d.fillRect(170, 50, 30, 30);
            console.log("Final test squares drawn");
            
        } catch (error) {
            console.warn("Failed to render inline symbol:", error);
        }

        renderer.ctx2d.restore();
    }

    #calculate_symbol_bbox(symbol: LibSymbol): BBox {
        console.log("Calculating symbol bbox for symbol with units:", symbol.units.size);
        
        // Calculate rough bounds based on symbol drawings
        let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
        let has_content = false;

        for (const [unit_number, unit_symbols] of symbol.units) {
            console.log(`Unit ${unit_number} has ${unit_symbols.length} symbol(s)`);
            for (const unit_symbol of unit_symbols) {
                console.log(`  Symbol has ${unit_symbol.drawings.length} drawings, ${unit_symbol.pins.length} pins`);
                
                // Include pin positions in bounding box
                for (const pin of unit_symbol.pins) {
                    if (pin.at && pin.at.position) {
                        has_content = true;
                        const pos = pin.at.position;
                        min_x = Math.min(min_x, pos.x - 2.54); // Add pin length
                        min_y = Math.min(min_y, pos.y - 2.54);
                        max_x = Math.max(max_x, pos.x + 2.54);
                        max_y = Math.max(max_y, pos.y + 2.54);
                        console.log(`    Pin at ${pos.x}, ${pos.y}`);
                    }
                }
                
                // Include drawing elements
                for (const _drawing of unit_symbol.drawings) {
                    has_content = true;
                    // Basic bbox for drawings - this is simplified
                    min_x = Math.min(min_x, -10);
                    min_y = Math.min(min_y, -10);
                    max_x = Math.max(max_x, 10);
                    max_y = Math.max(max_y, 10);
                    console.log(`    Drawing element found`);
                }
            }
        }

        const bbox = has_content 
            ? new BBox(min_x, min_y, max_x - min_x, max_y - min_y)
            : new BBox(-12.7, -12.7, 25.4, 25.4); // Default 1" square in KiCad units (0.1mm)
            
        console.log("Final bbox:", bbox);
        return bbox;
    }

    // Filter out properties not supported by LibSymbol parser to avoid "No def found" errors
    #filterUnsupportedSymbolProperties(symbolArray: any[]): any[] {
        // List of properties that exist in newer KiCad versions but aren't supported by kicanvas LibSymbol parser
        const unsupportedProperties = [
            'exclude_from_sim',  // KiCad 7+ simulation exclusion flag
            'embedded_fonts',    // KiCad 8+ embedded font support
        ];

        const filtered = [];
        for (let i = 0; i < symbolArray.length; i++) {
            const item = symbolArray[i];
            
            // Skip unsupported top-level properties and their values
            if (typeof item === 'string' && unsupportedProperties.includes(item)) {
                // Skip this property and its value (next item)
                i++; // Skip the value too
                continue;
            }
            
            // Skip empty strings that might result from filtering
            if (item === '' || item === null || item === undefined) {
                continue;
            }
            
            // Recursively filter nested arrays (like symbol definitions)
            if (Array.isArray(item)) {
                const filteredNested = this.#filterUnsupportedSymbolProperties(item);
                // Only add non-empty arrays
                if (filteredNested.length > 0) {
                    filtered.push(filteredNested);
                }
            } else {
                filtered.push(item);
            }
        }
        
        return filtered;
    }
}

window.customElements.define("kicanvas-embed", KiCanvasEmbedElement);

class KiCanvasSourceElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;

    @attribute({ type: String })
    type: string | null;
}

window.customElements.define("kicanvas-source", KiCanvasSourceElement);

/* Import required fonts.
 * TODO: Package these up as part of KiCanvas
 */
document.body.appendChild(
    html`<link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0&family=Nunito:wght@300;400;500;600;700&display=swap"
        crossorigin="anonymous" />`,
);
