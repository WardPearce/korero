import type { ThemeRegistrationRaw } from 'shiki/core';

// Colours come from the Kōrero default theme (frontend/src/app.css).
const c = {
	fg: '#f2f6fa',
	muted: '#8ea5bc',
	punct: '#aabac8',
	primary: '#5ce0cc',
	accent: '#b7acf3',
	success: '#6fd5a0',
	warning: '#f6bf74',
	info: '#83d3ee',
	destructive: '#ff929b'
};

export const korero: ThemeRegistrationRaw = {
	name: 'korero',
	type: 'dark',
	colors: { 'editor.background': '#111a22', 'editor.foreground': c.fg },
	settings: [
		{ settings: { foreground: c.fg, background: '#111a22' } },
		{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.muted, fontStyle: 'italic' } },
		{ scope: ['string', 'string.quoted'], settings: { foreground: c.success } },
		{ scope: ['constant.numeric', 'constant.language', 'constant.language.boolean'], settings: { foreground: c.warning } },
		{ scope: ['keyword', 'storage', 'keyword.control', 'keyword.operator.logical'], settings: { foreground: c.accent } },
		{ scope: ['entity.name.function', 'support.function', 'support.function.builtin', 'entity.name.command'], settings: { foreground: c.primary } },
		{ scope: ['variable', 'variable.other', 'variable.parameter', 'variable.other.normal', 'punctuation.definition.variable'], settings: { foreground: c.info } },
		{ scope: ['entity.name.tag', 'support.type.property-name', 'entity.name.section', 'entity.name.type.table', 'support.type.property-name.table', 'keyword.key'], settings: { foreground: c.primary } },
		{ scope: ['entity.name.section.group-title', 'punctuation.definition.table', 'markup.heading'], settings: { foreground: c.accent } },
		{ scope: ['string.unquoted.argument', 'constant.other.option', 'meta.function-call.arguments'], settings: { foreground: c.fg } },
		{ scope: ['punctuation', 'keyword.operator', 'meta.brace'], settings: { foreground: c.punct } },
		{ scope: ['invalid'], settings: { foreground: c.destructive } }
	]
};
