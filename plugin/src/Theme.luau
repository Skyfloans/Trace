--!strict

export type Palette = {
	accent: Color3,
	accentHover: Color3,
	accentInk: Color3,
	border: Color3,
	button: Color3,
	buttonHover: Color3,
	buttonPressed: Color3,
	error: Color3,
	input: Color3,
	inputBorder: Color3,
	main: Color3,
	muted: Color3,
	raised: Color3,
	success: Color3,
	text: Color3,
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
		text = studioTheme:GetColor(Enum.StudioStyleGuideColor.MainText),
		muted = studioTheme:GetColor(Enum.StudioStyleGuideColor.SubText),
		accent = Color3.fromRGB(237, 123, 102),
		accentHover = Color3.fromRGB(241, 140, 121),
		accentInk = Color3.fromRGB(24, 18, 15),
		success = Color3.fromRGB(126, 209, 173),
		error = Color3.fromRGB(255, 155, 146),
	}
end

return Theme
