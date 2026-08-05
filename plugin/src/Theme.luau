--!strict

export type Palette = {
	accent: Color3,
	accentHover: Color3,
	accentInk: Color3,
	border: Color3,
	button: Color3,
	buttonHover: Color3,
	buttonPressed: Color3,
	diffAddedBackground: Color3,
	diffAddedText: Color3,
	diffBackground: Color3,
	diffBorder: Color3,
	diffDeletedBackground: Color3,
	diffDeletedText: Color3,
	diffGutter: Color3,
	diffHeader: Color3,
	diffHunkBackground: Color3,
	diffText: Color3,
	error: Color3,
	input: Color3,
	inputBorder: Color3,
	main: Color3,
	muted: Color3,
	raised: Color3,
	success: Color3,
	text: Color3,
	title: Color3,
	warning: Color3,
}

local Theme = {}

function Theme.read(): Palette
	local studioTheme = settings().Studio.Theme
	return {
		main = studioTheme:GetColor(Enum.StudioStyleGuideColor.MainBackground),
		raised = studioTheme:GetColor(Enum.StudioStyleGuideColor.InputFieldBackground),
		input = studioTheme:GetColor(Enum.StudioStyleGuideColor.InputFieldBackground),
		border = studioTheme:GetColor(Enum.StudioStyleGuideColor.Border),
		inputBorder = studioTheme:GetColor(Enum.StudioStyleGuideColor.InputFieldBorder),
		button = studioTheme:GetColor(Enum.StudioStyleGuideColor.Button),
		buttonHover = studioTheme:GetColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Hover),
		buttonPressed = studioTheme:GetColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Pressed),
		diffBackground = Color3.fromRGB(13, 17, 23),
		diffBorder = Color3.fromRGB(48, 54, 61),
		diffHeader = Color3.fromRGB(22, 27, 34),
		diffHunkBackground = Color3.fromRGB(18, 35, 58),
		diffText = Color3.fromRGB(230, 237, 243),
		diffGutter = Color3.fromRGB(139, 148, 158),
		diffAddedBackground = Color3.fromRGB(15, 45, 32),
		diffAddedText = Color3.fromRGB(126, 231, 166),
		diffDeletedBackground = Color3.fromRGB(55, 25, 29),
		diffDeletedText = Color3.fromRGB(255, 129, 130),
		text = studioTheme:GetColor(Enum.StudioStyleGuideColor.MainText),
		title = studioTheme:GetColor(Enum.StudioStyleGuideColor.BrightText),
		muted = studioTheme:GetColor(Enum.StudioStyleGuideColor.SubText),
		accent = Color3.fromRGB(237, 123, 102),
		accentHover = Color3.fromRGB(241, 140, 121),
		accentInk = Color3.fromRGB(24, 18, 15),
		success = Color3.fromRGB(126, 209, 173),
		warning = Color3.fromRGB(229, 184, 102),
		error = Color3.fromRGB(255, 155, 146),
	}
end

return Theme
