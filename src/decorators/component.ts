import { defineComponent, getCurrentInstance, h, inject, InjectionKey, provide } from 'vue-demi'
import Vue from 'vue'
import { computedHandler } from './computed'
import { propsHandler } from './props'
import { refHandler } from './ref'
import { watchHandler } from './watch'
import { watchEffectHandler } from './watchEffect'
import { HookHandler } from './hook'
import {
	ClassProvider,
	Injectable,
	InjectionToken,
	Provider,
	ReflectiveInjector,
	ResolvedReflectiveProvider,
	SkipSelf,
	TypeProvider
} from 'injection-js'

export const InjectorKey: InjectionKey<ReflectiveInjector> = Symbol('ReflectiveInjector')

const MetadataKey = Symbol('Component')
const MetadataProviderKey = Symbol('ResolveProviders')

export interface ComponentOptions {
	/**
	 * 依赖的服务
	 */
	providers?: Provider[]
	/**
	 * 排除掉的服务
	 */
	exclude?: Provider[]
	/**
	 * 自动分析依赖
	 */
	autoResolveDeps?: boolean
	/**
	 * option是否是稳定的，
	 * 依赖解析只会在第一次的时候解析并且缓存下来，所以options如果是动态变化的，请标记
	 */
	stable?: boolean
}

const handlerList = [refHandler, computedHandler, watchHandler, watchEffectHandler, HookHandler]

export function Component(options?: ComponentOptions) {
	return function (Component: any) {
		const proto = Component.prototype
		const props = propsHandler.handler(Component)
		const vueOptions = defineComponent({
			name: proto.name || Component.name,
			props: props,
			setup(props) {
				const instance = resolveComponent(Component)
				Object.defineProperty(instance, '$props', {
					get() {
						return props
					}
				})
				handlerList.forEach(handler => handler.handler(instance))
				return instance.render.bind(instance, h)
			}
		})

		//@ts-ignore
		const Extended = Vue.extend(vueOptions)
		const params = Reflect.getMetadata('design:paramtypes', Component) as any[] | undefined
		if (params?.length || options?.providers?.length) {
			Reflect.defineMetadata(MetadataKey, options, Component)
			Injectable()(Component)
		}

		return Extended as any
	}
}

export function resolveComponent(target: { new (...args: []): any }) {
	// 如果没有使用 injection-js 则不创建注入器
	if (!Reflect.getMetadata('annotations', target)) return new target()
	const parent = inject(InjectorKey, null)
	// 从缓存中拿到解析过得依赖
	let resolveProviders: ResolvedReflectiveProvider[] = Reflect.getOwnMetadata(
		MetadataProviderKey,
		target
	)
	const options: ComponentOptions | undefined = Reflect.getOwnMetadata(MetadataKey, target)
	if (!resolveProviders || options?.stable === false) {
		// 依赖
		let deps: Provider[] = [target]
		if (options?.providers?.length) {
			deps = deps.concat(options.providers)
		}
		// 自动解析依赖的依赖
		if (options?.autoResolveDeps !== false) {
			deps = resolveDependencies(deps)
		}
		// 排除掉某些依赖
		if (options?.exclude?.length) {
			deps = deps.filter(k => !options.exclude?.includes(k))
		}

		resolveProviders = ReflectiveInjector.resolve(deps)
		// 缓存解析过的依赖, 提高性能
		Reflect.defineMetadata(MetadataProviderKey, resolveProviders, target)
	}
	const injector = ReflectiveInjector.fromResolvedProviders(resolveProviders, parent || undefined)

	provide(InjectorKey, injector)

	const compInstance = injector.get(target)

	// 处理一下providers中的未创建实例的服务
	resolveProviders.forEach(k => injector.get(k.key.token))
	return compInstance
}

export function resolveDependencies(inputs: Provider[]) {
	// 处理抽象类
	const noConstructor: Exclude<Provider, TypeProvider | any[]>[] = []

	for (const input of inputs) {
		if (!(input instanceof Function) && !Array.isArray(input)) {
			noConstructor.push(input)
		}
	}

	const deps = new Set<Provider>()

	function resolver(klass: Provider) {
		if (deps.has(klass) || noConstructor.find(k => k !== klass && k.provide === klass)) return
		deps.add(klass)
		const resolves = ReflectiveInjector.resolve([klass])
		for (const item of resolves) {
			for (const fact of item.resolvedFactories) {
				for (const dep of fact.dependencies) {
					if (
						dep.optional ||
						dep.visibility instanceof SkipSelf ||
						dep.key.token instanceof InjectionToken ||
						typeof dep.key.token !== 'function'
					) {
						continue
					}
					resolver(dep.key.token as unknown as ClassProvider)
				}
			}
		}
	}

	for (const input of inputs) resolver(input)

	return Array.from(deps)
}
