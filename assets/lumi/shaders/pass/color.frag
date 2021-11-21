#include lumi:shaders/pass/header.glsl

#include lumi:shaders/lib/bitpack.glsl
#include lumi:shaders/lib/pack_normal.glsl
#include lumi:shaders/prog/clouds.glsl
#include lumi:shaders/prog/fog.glsl
#include lumi:shaders/prog/overlay.glsl
#include lumi:shaders/prog/shading.glsl
#include lumi:shaders/prog/sky.glsl
#include lumi:shaders/prog/tonemap.glsl
#include lumi:shaders/prog/water.glsl

/*******************************************************
 *  lumi:shaders/post/color.frag
 *******************************************************/

uniform sampler2D u_vanilla_color;
uniform sampler2D u_vanilla_depth;
uniform sampler2D u_weather_color;
uniform sampler2D u_weather_depth;

uniform sampler2DArray u_gbuffer_main_etc;
uniform sampler2DArray u_gbuffer_depth;
uniform sampler2DArray u_gbuffer_light;
uniform sampler2DArray u_gbuffer_normal;
uniform sampler2DArrayShadow u_gbuffer_shadow;

uniform sampler2D u_tex_sun;
uniform sampler2D u_tex_moon;
uniform sampler2D u_tex_cloud;
uniform sampler2D u_tex_glint;
uniform sampler2D u_tex_noise;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out float fragDepth;
layout(location = 2) out vec4 fragAlbedo;

void main()
{
	float dSolid = texture(u_vanilla_depth, v_texcoord).r;
	float dTrans = texture(u_gbuffer_depth, vec3(v_texcoord, 0.)).r;

	vec2 uvSolid = refractSolidUV(u_gbuffer_normal, u_vanilla_depth, dSolid, dTrans);

	dSolid = texture(u_vanilla_depth, uvSolid).r;

	vec4  cSolid = texture(u_vanilla_color, uvSolid);
	vec4  cTrans = texture(u_gbuffer_main_etc, vec3(v_texcoord, ID_TRANS_COLR));
		  cTrans = vec4(cTrans.a == 0.0 ? vec3(0.0) : (cTrans.rgb / cTrans.a), sqrt(cTrans.a));
	float dParts = texture(u_gbuffer_depth, vec3(v_texcoord, 1.)).r;
	vec4  cParts = dParts > dSolid ? vec4(0.0) : texture(u_gbuffer_main_etc, vec3(v_texcoord, ID_PARTS_COLR));
	float dRains = texture(u_weather_depth, v_texcoord).r;
	vec4  cRains = texture(u_weather_color, v_texcoord);

	cParts.rgb /= cParts.a == 0.0 ? 1.0 : cParts.a;
	cRains.rgb /= cRains.a == 0.0 ? 1.0 : cRains.a;

	vec4 tempPos = frx_inverseViewProjectionMatrix * vec4(2.0 * uvSolid - 1.0, 2.0 * dSolid - 1.0, 1.0);
	vec3 eyePos  = tempPos.xyz / tempPos.w;

	vec4 light    = texture(u_gbuffer_light, vec3(uvSolid, ID_SOLID_LIGT));
	vec3 material = texture(u_gbuffer_main_etc, vec3(uvSolid, ID_SOLID_MATS)).xyz;
	vec3 normal   = texture(u_gbuffer_normal, vec3(uvSolid, ID_SOLID_MNORM)).xyz * 2.0 - 1.0;

	light.w = denoisedShadowFactor(u_gbuffer_shadow, uvSolid, eyePos, dSolid, light.y);

	vec3 miscTrans = texture(u_gbuffer_main_etc, vec3(v_texcoord, ID_TRANS_MISC)).xyz;
	bool transIsWater = bit_unpack(miscTrans.z, 7) == 1.;
	bool solidIsUnderwater = decideUnderwater(dSolid, dTrans, transIsWater, false);
	vec3 toFrag = normalize(eyePos);

	// TODO: end portal glitch?

	vec4 base = dSolid == 1.0 ? customSky(u_tex_sun, u_tex_moon, toFrag, solidIsUnderwater) : shading(cSolid, u_tex_cloud, light, material, eyePos, normal, solidIsUnderwater);
	vec4 next = (dSolid < dTrans && dSolid < dParts) ? vec4(0.0) : (dParts > dTrans ? cParts : cTrans);
	vec4 last = (dSolid < dTrans && dSolid < dParts) ? vec4(0.0) : (dParts > dTrans ? cTrans : cParts);

	float dMin = min(dSolid, min(dTrans, min(dParts, dRains)));

	if (dSolid > dMin) {
		if (dSolid < 1.0) {
			base += skyReflection(u_tex_sun, u_tex_moon, cSolid.rgb, material, toFrag, normal, light.yw);
			base = fog(base, eyePos, light.y);
		}

		vec4 clouds = volumetricCloud(u_tex_cloud, u_tex_noise, 1.0, uvSolid, eyePos, toFrag, NUM_SAMPLE, ldepth(dMin) * frx_viewDistance * 4.);
		base.rgb = base.rgb * (1.0 - clouds.a) + clouds.rgb * clouds.a;
	}

	if (dRains <= dSolid) {
		if (dRains == dMin) {
			last = vec4(last.rgb * (1.0 - cRains.a) + cRains.rgb * cRains.a, min(1.0, last.a + cRains.a));
		} else {
			next = vec4(next.rgb * (1.0 - cRains.a) + cRains.rgb * cRains.a, min(1.0, next.a + cRains.a));
		}
	}

	next = vec4(next.rgb * (1.0 - last.a) + last.rgb * last.a, min(1.0, next.a + last.a));

	tempPos = frx_inverseViewProjectionMatrix * vec4(2.0 * v_texcoord - 1.0, 2.0 * dMin - 1.0, 1.0);
	eyePos  = tempPos.xyz / tempPos.w;

	light	 = vec4(0.0, 1.0, 0.0, 0.0);
	material = vec3(1.0, 0.0, 0.04);
	normal	 = -frx_cameraView;

	if (dMin == dTrans) {
		light    = texture(u_gbuffer_light, vec3(v_texcoord, ID_TRANS_LIGT));
		material = texture(u_gbuffer_main_etc, vec3(v_texcoord, ID_TRANS_MATS)).xyz;
		normal   = texture(u_gbuffer_normal, vec3(v_texcoord, 3.)).xyz * 2.0 - 1.0;
	} else if (dMin == dParts) {
		light    = texture(u_gbuffer_light, vec3(v_texcoord, ID_PARTS_LIGT));
	}

	bool nextIsUnderwater = decideUnderwater(dMin, dTrans, transIsWater, true);

	light.w = transIsWater ? lightmapRemap (light.y) : denoisedShadowFactor(u_gbuffer_shadow, v_texcoord, eyePos, dMin, light.y);

	if (next.a != 0.0) {
		vec3 albedo = next.rgb;
		next = shading(next, u_tex_cloud, light, material, eyePos, normal, nextIsUnderwater);
		next.a = sqrt(next.a);
	}

	base.rgb = base.rgb * (1.0 - next.a) + next.rgb * next.a;

	int idMisc = dMin == dSolid ? ID_SOLID_MISC : (dMin == dTrans ? ID_TRANS_MISC : -1);

	if (idMisc > -1) {
		vec2 uvAuto = idMisc == ID_SOLID_MISC ? uvSolid : v_texcoord;
		vec4 miscAuto = texture(u_gbuffer_main_etc, vec3(uvAuto, idMisc));
		base = overlay(base, u_tex_glint, miscAuto);
	}

	fragColor = base;
	fragDepth = dMin;

	if (dMin == dSolid) {
		fragAlbedo = vec4(cSolid.rgb, 0.0);
	} else if (dMin == dTrans) {
		fragAlbedo = vec4(cTrans.rgb, 0.5);
	} else {
		fragAlbedo = vec4(cParts.rgb, 1.0);
	}
}