// Imperative manager for one layer of OSM raster tiles draped on the globe. Holds
// a THREE.Group of curved tile-patch meshes and keeps it in sync with a desired
// tile set: new tiles are fetched and added once their texture loads; tiles that
// leave the set are removed and their GPU resources freed. The Svelte components
// stay declarative and hand this class the tile list; all the three.js churn
// (texture loading, disposal, race handling) lives here.

import {
	BufferAttribute,
	BufferGeometry,
	ClampToEdgeWrapping,
	DoubleSide,
	Group,
	LinearFilter,
	LinearMipmapLinearFilter,
	Mesh,
	MeshBasicMaterial,
	SRGBColorSpace,
	type Texture,
	TextureLoader
} from 'three';
import { buildTilePatch, type Tile } from './geo';

type TileLayerOptions = {
	radius: number;
	/** Mesh subdivision for a tile at the given zoom (flatter tiles need less). */
	segments: (z: number) => number;
	/** How far above the sphere this layer sits (fraction of radius). */
	altitude: number;
	/** Resolve a tile to its image URL. */
	tileUrl: (z: number, x: number, y: number) => string;
	/**
	 * Depth-bias level for stacking. Each layer is pulled toward the camera in the
	 * depth buffer by this amount (a polygon offset), so a higher level reliably
	 * draws on top of a lower one regardless of how tight the near plane is. The
	 * base sphere is level 0, base tiles 1, detail tiles 2 — keeping the imagery
	 * from z-fighting now that the altitude gaps between layers are tiny. 0 = none.
	 */
	polygonOffsetLevel?: number;
	/** Optional hook fired after the group changes, for on-demand re-rendering. */
	onUpdate?: () => void;
};

const tileKey = (tile: Tile): string => `${tile.z}/${tile.x}/${tile.y}`;

export class TileLayer {
	/** The object to add to the scene; its children are the live tile meshes. */
	readonly group = new Group();

	private readonly meshes = new Map<string, Mesh>();
	private readonly loading = new Set<string>();
	private wanted = new Set<string>();
	private readonly loader = new TextureLoader();
	private destroyed = false;

	constructor(private readonly options: TileLayerOptions) {
		this.loader.setCrossOrigin('anonymous');
	}

	/** Replace the desired tile set; meshes are added/removed to match. */
	setTiles(tiles: Tile[]): void {
		if (this.destroyed) return;

		const next = new Set<string>(tiles.map(tileKey));
		this.wanted = next;

		for (const tile of tiles) {
			const key = tileKey(tile);
			if (this.meshes.has(key) || this.loading.has(key)) continue;
			this.fetchTile(tile, key);
		}

		for (const [key, mesh] of this.meshes) {
			if (!next.has(key)) this.disposeMesh(key, mesh);
		}
	}

	private fetchTile(tile: Tile, key: string): void {
		this.loading.add(key);
		const url = this.options.tileUrl(tile.z, tile.x, tile.y);
		this.loader.load(
			url,
			(texture) => {
				this.loading.delete(key);
				// The view may have moved on (or the layer torn down) while the image
				// was in flight — in which case the texture is no longer needed.
				if (this.destroyed || !this.wanted.has(key) || this.meshes.has(key)) {
					texture.dispose();
					return;
				}
				this.addMesh(tile, key, texture);
			},
			undefined,
			() => {
				// 404 / network error: free the slot so a later view can retry the tile.
				this.loading.delete(key);
			}
		);
	}

	private addMesh(tile: Tile, key: string, texture: Texture): void {
		texture.colorSpace = SRGBColorSpace;
		texture.minFilter = LinearMipmapLinearFilter;
		texture.magFilter = LinearFilter;
		texture.wrapS = ClampToEdgeWrapping;
		texture.wrapT = ClampToEdgeWrapping;
		texture.generateMipmaps = true;

		const patch = buildTilePatch(
			tile,
			this.options.radius,
			this.options.segments(tile.z),
			this.options.altitude
		);
		const geometry = new BufferGeometry();
		geometry.setAttribute('position', new BufferAttribute(patch.positions, 3));
		geometry.setAttribute('uv', new BufferAttribute(patch.uvs, 2));
		geometry.setIndex(new BufferAttribute(patch.indices, 1));

		// Unlit imagery (MeshBasic) so the whole globe stays evenly readable, and
		// DoubleSide so a patch is visible regardless of winding. The polygon offset
		// (negative = toward the camera, scaled by the layer's level) stacks the
		// layers without relying on fine depth precision.
		const level = this.options.polygonOffsetLevel ?? 0;
		const material = new MeshBasicMaterial({
			map: texture,
			side: DoubleSide,
			polygonOffset: level > 0,
			polygonOffsetFactor: -level,
			polygonOffsetUnits: -level
		});
		const mesh = new Mesh(geometry, material);
		mesh.frustumCulled = true;

		this.meshes.set(key, mesh);
		this.group.add(mesh);
		this.options.onUpdate?.();
	}

	private disposeMesh(key: string, mesh: Mesh): void {
		this.meshes.delete(key);
		this.group.remove(mesh);
		mesh.geometry.dispose();
		const material = mesh.material as MeshBasicMaterial;
		material.map?.dispose();
		material.dispose();
		this.options.onUpdate?.();
	}

	/** Tear down: remove every mesh and free all GPU resources. */
	dispose(): void {
		this.destroyed = true;
		this.wanted.clear();
		this.loading.clear();
		for (const [key, mesh] of this.meshes) this.disposeMesh(key, mesh);
		this.meshes.clear();
	}
}
