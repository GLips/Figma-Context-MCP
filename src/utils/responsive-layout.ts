import { SimplifiedDesign } from "../services/simplify-node-response";

/**
 * Generates SwiftUI code for responsive layout handling
 */
export function generateResponsiveLayoutCode(): string {
  let code = 'import SwiftUI\n\n';
  
  // Add device size detection
  code += '// MARK: - Device Size Detection\n';
  code += 'enum DeviceSize {\n';
  code += '    case small    // iPhone SE, iPhone 8, etc.\n';
  code += '    case medium   // iPhone X, iPhone 11, etc.\n';
  code += '    case large    // iPhone Pro Max, etc.\n';
  code += '    case iPad     // All iPads\n';
  code += '    \n';
  code += '    static var current: DeviceSize {\n';
  code += '        let screenWidth = UIScreen.main.bounds.width\n';
  code += '        let screenHeight = UIScreen.main.bounds.height\n';
  code += '        let maxDimension = max(screenWidth, screenHeight)\n';
  code += '        \n';
  code += '        switch maxDimension {\n';
  code += '        case 0..<668: return .small\n';
  code += '        case 668..<926: return .medium\n';
  code += '        case 926..<1024: return .large\n';
  code += '        default: return .iPad\n';
  code += '        }\n';
  code += '    }\n';
  code += '}\n\n';
  
  // Add responsive spacing
  code += '// MARK: - Responsive Spacing\n';
  code += 'struct ResponsiveSpacing {\n';
  code += '    static func value(_ small: CGFloat, medium: CGFloat? = nil, large: CGFloat? = nil, iPad: CGFloat? = nil) -> CGFloat {\n';
  code += '        switch DeviceSize.current {\n';
  code += '        case .small: return small\n';
  code += '        case .medium: return medium ?? small\n';
  code += '        case .large: return large ?? medium ?? small\n';
  code += '        case .iPad: return iPad ?? large ?? medium ?? small\n';
  code += '        }\n';
  code += '    }\n';
  code += '}\n\n';
  
  // Add responsive font sizes
  code += '// MARK: - Responsive Font Sizes\n';
  code += 'struct ResponsiveFont {\n';
  code += '    static func size(_ small: CGFloat, medium: CGFloat? = nil, large: CGFloat? = nil, iPad: CGFloat? = nil) -> CGFloat {\n';
  code += '        switch DeviceSize.current {\n';
  code += '        case .small: return small\n';
  code += '        case .medium: return medium ?? small\n';
  code += '        case .large: return large ?? medium ?? small\n';
  code += '        case .iPad: return iPad ?? large ?? medium ?? small\n';
  code += '        }\n';
  code += '    }\n';
  code += '    \n';
  code += '    static func system(size: CGFloat, weight: Font.Weight = .regular) -> Font {\n';
  code += '        return .system(size: ResponsiveFont.size(size), weight: weight)\n';
  code += '    }\n';
  code += '}\n\n';
  
  // Add responsive view modifiers
  code += '// MARK: - Responsive View Modifiers\n';
  code += 'struct ResponsivePadding: ViewModifier {\n';
  code += '    let small: CGFloat\n';
  code += '    let medium: CGFloat?\n';
  code += '    let large: CGFloat?\n';
  code += '    let iPad: CGFloat?\n';
  code += '    \n';
  code += '    init(_ small: CGFloat, medium: CGFloat? = nil, large: CGFloat? = nil, iPad: CGFloat? = nil) {\n';
  code += '        self.small = small\n';
  code += '        self.medium = medium\n';
  code += '        self.large = large\n';
  code += '        self.iPad = iPad\n';
  code += '    }\n';
  code += '    \n';
  code += '    func body(content: Content) -> some View {\n';
  code += '        content.padding(ResponsiveSpacing.value(small, medium: medium, large: large, iPad: iPad))\n';
  code += '    }\n';
  code += '}\n\n';
  
  code += 'struct ResponsiveFrame: ViewModifier {\n';
  code += '    let smallWidth: CGFloat?\n';
  code += '    let smallHeight: CGFloat?\n';
  code += '    let mediumWidth: CGFloat?\n';
  code += '    let mediumHeight: CGFloat?\n';
  code += '    let largeWidth: CGFloat?\n';
  code += '    let largeHeight: CGFloat?\n';
  code += '    let iPadWidth: CGFloat?\n';
  code += '    let iPadHeight: CGFloat?\n';
  code += '    \n';
  code += '    init(\n';
  code += '        smallWidth: CGFloat? = nil,\n';
  code += '        smallHeight: CGFloat? = nil,\n';
  code += '        mediumWidth: CGFloat? = nil,\n';
  code += '        mediumHeight: CGFloat? = nil,\n';
  code += '        largeWidth: CGFloat? = nil,\n';
  code += '        largeHeight: CGFloat? = nil,\n';
  code += '        iPadWidth: CGFloat? = nil,\n';
  code += '        iPadHeight: CGFloat? = nil\n';
  code += '    ) {\n';
  code += '        self.smallWidth = smallWidth\n';
  code += '        self.smallHeight = smallHeight\n';
  code += '        self.mediumWidth = mediumWidth\n';
  code += '        self.mediumHeight = mediumHeight\n';
  code += '        self.largeWidth = largeWidth\n';
  code += '        self.largeHeight = largeHeight\n';
  code += '        self.iPadWidth = iPadWidth\n';
  code += '        self.iPadHeight = iPadHeight\n';
  code += '    }\n';
  code += '    \n';
  code += '    func body(content: Content) -> some View {\n';
  code += '        let width: CGFloat?\n';
  code += '        let height: CGFloat?\n';
  code += '        \n';
  code += '        switch DeviceSize.current {\n';
  code += '        case .small:\n';
  code += '            width = smallWidth\n';
  code += '            height = smallHeight\n';
  code += '        case .medium:\n';
  code += '            width = mediumWidth ?? smallWidth\n';
  code += '            height = mediumHeight ?? smallHeight\n';
  code += '        case .large:\n';
  code += '            width = largeWidth ?? mediumWidth ?? smallWidth\n';
  code += '            height = largeHeight ?? mediumHeight ?? smallHeight\n';
  code += '        case .iPad:\n';
  code += '            width = iPadWidth ?? largeWidth ?? mediumWidth ?? smallWidth\n';
  code += '            height = iPadHeight ?? largeHeight ?? mediumHeight ?? smallHeight\n';
  code += '        }\n';
  code += '        \n';
  code += '        return content.frame(width: width, height: height)\n';
  code += '    }\n';
  code += '}\n\n';
  
  // Add view extensions
  code += '// MARK: - View Extensions\n';
  code += 'extension View {\n';
  code += '    func responsivePadding(_ small: CGFloat, medium: CGFloat? = nil, large: CGFloat? = nil, iPad: CGFloat? = nil) -> some View {\n';
  code += '        modifier(ResponsivePadding(small, medium: medium, large: large, iPad: iPad))\n';
  code += '    }\n';
  code += '    \n';
  code += '    func responsiveFrame(\n';
  code += '        smallWidth: CGFloat? = nil,\n';
  code += '        smallHeight: CGFloat? = nil,\n';
  code += '        mediumWidth: CGFloat? = nil,\n';
  code += '        mediumHeight: CGFloat? = nil,\n';
  code += '        largeWidth: CGFloat? = nil,\n';
  code += '        largeHeight: CGFloat? = nil,\n';
  code += '        iPadWidth: CGFloat? = nil,\n';
  code += '        iPadHeight: CGFloat? = nil\n';
  code += '    ) -> some View {\n';
  code += '        modifier(ResponsiveFrame(\n';
  code += '            smallWidth: smallWidth,\n';
  code += '            smallHeight: smallHeight,\n';
  code += '            mediumWidth: mediumWidth,\n';
  code += '            mediumHeight: mediumHeight,\n';
  code += '            largeWidth: largeWidth,\n';
  code += '            largeHeight: largeHeight,\n';
  code += '            iPadWidth: iPadWidth,\n';
  code += '            iPadHeight: iPadHeight\n';
  code += '        ))\n';
  code += '    }\n';
  code += '    \n';
  code += '    func responsiveFont(size: CGFloat, weight: Font.Weight = .regular) -> some View {\n';
  code += '        self.font(ResponsiveFont.system(size: size, weight: weight))\n';
  code += '    }\n';
  code += '}\n';
  
  return code;
}

/**
 * Analyzes a design to determine if it should use responsive layout
 */
export function shouldUseResponsiveLayout(design: SimplifiedDesign): boolean {
  // Check if the design has a frame that's likely a mobile screen
  const rootNode = design.nodes[0];
  
  // Check if the root node has a bounding box with dimensions
  if (rootNode && rootNode.boundingBox) {
    const { width, height } = rootNode.boundingBox;
    
    // Check if dimensions match common mobile screen sizes
    if (width && height) {
      // Common mobile widths: 375, 390, 414, 428
      // Common mobile heights: 667, 812, 844, 896, 926
      const commonWidths = [375, 390, 414, 428];
      const commonHeights = [667, 812, 844, 896, 926];
      
      const isCommonWidth = commonWidths.some(w => Math.abs(width - w) < 10);
      const isCommonHeight = commonHeights.some(h => Math.abs(height - h) < 10);
      
      return isCommonWidth || isCommonHeight;
    }
  }
  
  return false;
} 