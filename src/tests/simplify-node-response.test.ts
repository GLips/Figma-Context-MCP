import { parseFigmaResponse } from '../services/simplify-node-response';
import type { GetFileResponse, Node as FigmaNode, Document as FigmaDocument, Canvas, Paint, FillType } from '@figma/rest-api-spec';
import { mock } from 'node:test';

// Helper to create a basic Figma file response
const createMockFigmaFileResponse = (nodes: FigmaNode[]): GetFileResponse => ({
  name: 'Test File',
  lastModified: new Date().toISOString(),
  thumbnailUrl: 'http://example.com/thumbnail.png',
  version: '1',
  document: {
    id: '0:0',
    name: 'Test Document',
    type: 'DOCUMENT',
    children: nodes,
  } as FigmaDocument,
  components: {},
  componentSets: {},
  schemaVersion: 0,
  styles: {},
});

// Helper to create a basic Figma node
const createMockFigmaNode = (id: string, name: string, type: FigmaNode['type'], visible: boolean = true, children: FigmaNode[] = [], extraProps: Partial<FigmaNode> = {}): FigmaNode => ({
  id,
  name,
  type,
  visible,
  children,
  ...extraProps,
} as FigmaNode);


describe('parseFigmaResponse', () => {
  it('should parse basic node properties correctly and handle visibility', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('1:1', 'Visible Frame', 'FRAME', true, [], { absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } }),
      createMockFigmaNode('1:2', 'Invisible Frame', 'FRAME', false),
      createMockFigmaNode('1:3', 'Visible Text', 'TEXT', true, [], { characters: 'Hello' }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.nodes.length).toBe(2);
    expect(simplifiedDesign.nodes[0].id).toBe('1:1');
    expect(simplifiedDesign.nodes[0].name).toBe('Visible Frame');
    expect(simplifiedDesign.nodes[0].type).toBe('FRAME');
    expect(simplifiedDesign.nodes[0].boundingBox).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(simplifiedDesign.nodes[1].id).toBe('1:3');
    expect(simplifiedDesign.nodes[1].name).toBe('Visible Text');
    expect(simplifiedDesign.nodes[1].type).toBe('TEXT');
  });

  it('should handle nested child nodes and their visibility', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('10:1', 'Parent Frame', 'FRAME', true, [
        createMockFigmaNode('10:2', 'Visible Child', 'RECTANGLE', true),
        createMockFigmaNode('10:3', 'Invisible Child', 'RECTANGLE', false),
        createMockFigmaNode('10:4', 'Visible Grandchild Parent', 'FRAME', true, [
          createMockFigmaNode('10:5', 'Visible Grandchild', 'ELLIPSE', true)
        ]),
      ]),
      createMockFigmaNode('11:1', 'Invisible Parent', 'FRAME', false, [
        createMockFigmaNode('11:2', 'Child of Invisible', 'RECTANGLE', true),
      ]),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.nodes.length).toBe(1); // Only Parent Frame
    expect(simplifiedDesign.nodes[0].children?.length).toBe(2); // Visible Child and Visible Grandchild Parent
    expect(simplifiedDesign.nodes[0].children?.[0].id).toBe('10:2');
    expect(simplifiedDesign.nodes[0].children?.[1].id).toBe('10:4');
    expect(simplifiedDesign.nodes[0].children?.[1].children?.length).toBe(1);
    expect(simplifiedDesign.nodes[0].children?.[1].children?.[0].id).toBe('10:5');
  });

  it('should create globalVars for identical styles and reference them', () => {
    const textStyle1: Partial<FigmaNode> = { style: { fontFamily: 'Arial', fontWeight: 400, fontSize: 12 } };
    const fillStyle1: Partial<FigmaNode> = { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] as Paint[] };

    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('2:1', 'Text 1', 'TEXT', true, [], textStyle1),
      createMockFigmaNode('2:2', 'Text 2', 'TEXT', true, [], textStyle1), // Same text style
      createMockFigmaNode('2:3', 'Rect 1', 'RECTANGLE', true, [], fillStyle1),
      createMockFigmaNode('2:4', 'Rect 2', 'RECTANGLE', true, [], fillStyle1), // Same fill style
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(Object.keys(simplifiedDesign.globalVars.styles).length).toBe(2); // One for text, one for fill
    const textStyleVarId = simplifiedDesign.nodes[0].textStyle;
    const fillStyleVarId = simplifiedDesign.nodes[2].fills;

    expect(textStyleVarId).toBeDefined();
    expect(simplifiedDesign.nodes[1].textStyle).toBe(textStyleVarId); // Text 2 references same style

    expect(fillStyleVarId).toBeDefined();
    expect(simplifiedDesign.nodes[3].fills).toBe(fillStyleVarId); // Rect 2 references same style

    // Check actual style content in globalVars (simplified)
    const textStyleInGlobal = simplifiedDesign.globalVars.styles[textStyleVarId!];
    expect(textStyleInGlobal).toEqual(expect.objectContaining({ fontFamily: 'Arial', fontWeight: 400, fontSize: 12 }));

    const fillStyleInGlobal = simplifiedDesign.globalVars.styles[fillStyleVarId!];
    expect(fillStyleInGlobal).toEqual([{ type: 'SOLID', hex: '#ff0000', opacity: 1, rgba: 'rgba(255, 0, 0, 1)' }]);
  });

  it('should parse component instance properties', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('3:1', 'Instance Node', 'INSTANCE', true, [], {
        componentId: 'comp-123',
        componentProperties: { 'variant#1': { value: 'true', type: 'BOOLEAN' } },
      }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.nodes[0].componentId).toBe('comp-123');
    expect(simplifiedDesign.nodes[0].componentProperties).toEqual({ 'variant#1': { value: 'true', type: 'BOOLEAN' } });
  });

  it('should parse text node content and style', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('4:1', 'Hello Text', 'TEXT', true, [], {
        characters: 'Hello World',
        style: { fontFamily: 'Roboto', fontSize: 24, textAlignHorizontal: 'CENTER' },
      }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.nodes[0].text).toBe('Hello World');
    expect(simplifiedDesign.nodes[0].textStyle).toBeDefined();
    const textStyleVarId = simplifiedDesign.nodes[0].textStyle!;
    expect(simplifiedDesign.globalVars.styles[textStyleVarId]).toEqual(
      expect.objectContaining({ fontFamily: 'Roboto', fontSize: 24, textAlignHorizontal: 'CENTER' })
    );
  });

  it('should parse appearance properties like opacity and borderRadius', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('5:1', 'Transparent Box', 'RECTANGLE', true, [], { opacity: 0.5, cornerRadius: 10 }),
      createMockFigmaNode('5:2', 'Complex Radius Box', 'RECTANGLE', true, [], { rectangleCornerRadii: [5, 10, 15, 20] }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.nodes[0].opacity).toBe(0.5);
    expect(simplifiedDesign.nodes[0].borderRadius).toBe('10px');
    expect(simplifiedDesign.nodes[1].borderRadius).toBe('5px 10px 15px 20px');
  });

  it('should populate imageAssets for VECTOR nodes and change node type to IMAGE-SVG', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('6:1', 'My Vector Icon', 'VECTOR', true, [], { absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } }),
      createMockFigmaNode('6:2', 'Another Vector', 'VECTOR', true, [], { absoluteBoundingBox: { x: 10, y: 10, width: 32, height: 32 } }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.nodes[0].type).toBe('IMAGE-SVG');
    expect(simplifiedDesign.nodes[1].type).toBe('IMAGE-SVG');

    expect(simplifiedDesign.imageAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SVG', nodeId: '6:1', fileNameSuggestion: 'My_Vector_Icon.svg' }),
        expect.objectContaining({ type: 'SVG', nodeId: '6:2', fileNameSuggestion: 'Another_Vector.svg' }),
      ])
    );
    expect(simplifiedDesign.imageAssets.length).toBe(2);
  });

  it('should populate imageAssets for image fills and handle de-duplication', () => {
    const imageFill1: Paint = { type: 'IMAGE', imageRef: 'ref123', scaleMode: 'FILL' };
    const imageFill2: Paint = { type: 'IMAGE', imageRef: 'ref456', scaleMode: 'FIT' };

    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('7:1', 'Image Fill Node 1', 'RECTANGLE', true, [], { fills: [imageFill1] }),
      createMockFigmaNode('7:2', 'Image Fill Node 2', 'ELLIPSE', true, [], { fills: [imageFill2] }),
      createMockFigmaNode('7:3', 'Shared Image Fill', 'FRAME', true, [], { fills: [imageFill1] }), // Shares imageRef with 7:1
      createMockFigmaNode('7:4', 'Vector Here', 'VECTOR', true, [], {name: 'A_Vector_Also'}),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.imageAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'FILL', nodeId: '7:1', imageRef: 'ref123', fileNameSuggestion: 'Image_Fill_Node_1_fill.png' }),
        expect.objectContaining({ type: 'FILL', nodeId: '7:2', imageRef: 'ref456', fileNameSuggestion: 'Image_Fill_Node_2_fill.png' }),
        expect.objectContaining({ type: 'SVG', nodeId: '7:4', fileNameSuggestion: 'A_Vector_Also.svg' }),
      ])
    );
    // De-duplication: ref123 should only appear once, even if used in 7:1 and 7:3.
    // The SVG from 7:4 should also be present.
    expect(simplifiedDesign.imageAssets.length).toBe(3);
    const fillImageAssets = simplifiedDesign.imageAssets.filter(asset => asset.type === 'FILL');
    const uniqueImageRefs = new Set(fillImageAssets.map(asset => asset.imageRef));
    expect(uniqueImageRefs.size).toBe(fillImageAssets.length); // Ensures no duplicate imageRefs for FILL types
  });

  it('should return an empty imageAssets array if no vector or image fills are present', () => {
    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('8:1', 'Just a Box', 'RECTANGLE', true, [], { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }] as Paint[] }),
      createMockFigmaNode('8:2', 'Some Text', 'TEXT', true, [], { characters: 'No images here' }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(simplifiedDesign.imageAssets).toEqual([]);
  });

  it('should correctly parse different types of fills (solid, gradient) into globalVars', () => {
    const solidFill: Paint[] = [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.6, a: 0.8 } }];
    const gradientFill: Paint[] = [{
      type: 'GRADIENT_LINEAR',
      gradientHandlePositions: [{x: 0, y: 0}, {x:1, y:1}],
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    }];

    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('9:1', 'Solid Fill Rect', 'RECTANGLE', true, [], { fills: solidFill }),
      createMockFigmaNode('9:2', 'Gradient Fill Rect', 'RECTANGLE', true, [], { fills: gradientFill }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    expect(Object.keys(simplifiedDesign.globalVars.styles).length).toBe(2); // Two different fills

    const solidFillVarId = simplifiedDesign.nodes[0].fills;
    const gradientFillVarId = simplifiedDesign.nodes[1].fills;

    expect(solidFillVarId).toBeDefined();
    const solidFillInGlobal = simplifiedDesign.globalVars.styles[solidFillVarId!];
    expect(solidFillInGlobal).toEqual([{
      type: 'SOLID',
      hex: '#336699', // 0.2*255 = 51 (33), 0.4*255 = 102 (66), 0.6*255 = 153 (99)
      opacity: 0.8,
      rgba: 'rgba(51, 102, 153, 0.8)'
    }]);

    expect(gradientFillVarId).toBeDefined();
    const gradientFillInGlobal = simplifiedDesign.globalVars.styles[gradientFillVarId!];
    expect(gradientFillInGlobal).toEqual([{
      type: 'GRADIENT_LINEAR',
      gradientHandlePositions: [{x: 0, y: 0}, {x:1, y:1}],
      gradientStops: [
        { position: 0, color: { hex: '#ff0000', opacity: 1, rgba: 'rgba(255, 0, 0, 1)' } },
        { position: 1, color: { hex: '#0000ff', opacity: 1, rgba: 'rgba(0, 0, 255, 1)' } },
      ],
    }]);
  });

  it('should parse layout properties and create globalVars', () => {
    // Mock buildSimplifiedLayout to return a predictable layout object
    // This is a bit of a simplification as buildSimplifiedLayout can be complex
    const mockLayout1: Partial<FigmaNode> = { layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 4, paddingRight: 4 };
    const mockLayout2: Partial<FigmaNode> = { layoutMode: 'VERTICAL', primaryAxisSizingMode: 'AUTO' };


    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('10:1', 'Layout Frame 1', 'FRAME', true, [], mockLayout1),
      createMockFigmaNode('10:2', 'Layout Frame 2', 'FRAME', true, [], mockLayout1), // Same layout
      createMockFigmaNode('10:3', 'Layout Frame 3', 'FRAME', true, [], mockLayout2),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    // Expecting 2 unique layout styles in globalVars (mockLayout1, mockLayout2)
    // Note: buildSimplifiedLayout adds 'type: frame' to every layout object it creates.
    // And also, if only 'type:frame' is present, it won't create a var for it.
    // So we expect 2 global vars here because our mockLayouts have more than just type.
    expect(Object.values(simplifiedDesign.globalVars.styles).filter(style => typeof style === 'object' && 'layoutMode' in style).length).toBe(2);


    const layoutVarId1 = simplifiedDesign.nodes[0].layout;
    expect(layoutVarId1).toBeDefined();
    expect(simplifiedDesign.nodes[1].layout).toBe(layoutVarId1); // Frame 2 references same layout

    const layoutVarId2 = simplifiedDesign.nodes[2].layout;
    expect(layoutVarId2).toBeDefined();
    expect(layoutVarId2).not.toBe(layoutVarId1);

    const layoutStyle1InGlobal = simplifiedDesign.globalVars.styles[layoutVarId1!];
    expect(layoutStyle1InGlobal).toEqual(expect.objectContaining({ layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 4, paddingRight: 4 }));

    const layoutStyle2InGlobal = simplifiedDesign.globalVars.styles[layoutVarId2!];
    expect(layoutStyle2InGlobal).toEqual(expect.objectContaining({ layoutMode: 'VERTICAL', primaryAxisSizingMode: 'AUTO' }));
  });

  it('should parse strokes and effects and create globalVars', () => {
    const strokeStyle1: Partial<FigmaNode> = { strokes: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }], strokeWeight: 2 };
    const effectStyle1: Partial<FigmaNode> = { effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 2, y: 2 }, radius: 4, visible: true }] };

    const mockNodes: FigmaNode[] = [
      createMockFigmaNode('11:1', 'Stroked Rect', 'RECTANGLE', true, [], { ...strokeStyle1 }),
      createMockFigmaNode('11:2', 'Shadowed Ellipse', 'ELLIPSE', true, [], { ...effectStyle1 }),
      createMockFigmaNode('11:3', 'Stroked & Shadowed Frame', 'FRAME', true, [], { ...strokeStyle1, ...effectStyle1 }),
    ];
    const mockFigmaData = createMockFigmaFileResponse(mockNodes);
    const simplifiedDesign = parseFigmaResponse(mockFigmaData);

    // Expecting 1 stroke style and 1 effect style in globalVars
    // The actual count might be higher due to other default styles, so we filter
    const strokeStylesInGlobal = Object.values(simplifiedDesign.globalVars.styles).filter(
        (style): style is any => typeof style === 'object' && style !== null && 'colors' in style && 'weights' in style && 'align' in style
    );
    const effectStylesInGlobal = Object.values(simplifiedDesign.globalVars.styles).filter(
        (style): style is any => typeof style === 'object' && style !== null && ('dropShadows' in style || 'innerShadows' in style || 'layerBlurs' in style || 'backgroundBlurs' in style)
    );

    expect(strokeStylesInGlobal.length).toBe(1);
    expect(effectStylesInGlobal.length).toBe(1);


    const strokeVarId1 = simplifiedDesign.nodes[0].strokes;
    expect(strokeVarId1).toBeDefined();
    expect(simplifiedDesign.globalVars.styles[strokeVarId1!]).toEqual(
      expect.objectContaining({
        colors: [expect.objectContaining({ hex: '#00ff00' })], // Simplified stroke structure
        weights: { top: 2, right: 2, bottom: 2, left: 2 }, // Assuming uniform stroke weight from strokeWeight
      })
    );

    const effectVarId1 = simplifiedDesign.nodes[1].effects;
    expect(effectVarId1).toBeDefined();
    expect(simplifiedDesign.globalVars.styles[effectVarId1!]).toEqual(
      expect.objectContaining({
        dropShadows: [expect.objectContaining({ color: expect.objectContaining({ hex: '#000000', opacity: 0.5 }) })],
      })
    );

    // Node 3 should reference both
    expect(simplifiedDesign.nodes[2].strokes).toBe(strokeVarId1);
    expect(simplifiedDesign.nodes[2].effects).toBe(effectVarId1);
  });
});
