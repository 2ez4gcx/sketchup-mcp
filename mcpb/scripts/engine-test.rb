# Offline tests of the measuring engine of the bridge (extension/su_mcp/main.rb), without SketchUp:
#   ruby mcpb/scripts/engine-test.rb
# The bridge source is evaluated inside a module that holds a small stand-in for the SketchUp API (points, vectors,
# faces with loops and shared edges, ray tests against the faces built here), so mt_piece and its helpers run on
# known shapes and the figures can be checked by hand. Everything stays inside SuMcpOffline: the file can also be
# loaded in the Ruby console of a running SketchUp without touching the real bridge or the model.
unless 1.respond_to?(:mm)
  class Numeric
    def mm
      self / 25.4
    end

    def to_mm
      self * 25.4
    end

    def degrees
      self * Math::PI / 180.0
    end
  end
end

module SuMcpOffline
  MAIN = ENV['SU_MCP_MAIN'] || File.expand_path('../../extension/su_mcp/main.rb', File.dirname(__FILE__))

  module Geom
    class Vector3d
      attr_reader :x, :y, :z

      def initialize(x = 0.0, y = 0.0, z = 0.0)
        @x = x.to_f
        @y = y.to_f
        @z = z.to_f
      end

      def length
        Math.sqrt(@x * @x + @y * @y + @z * @z)
      end

      def normalize
        l = length
        l > 0 ? Vector3d.new(@x / l, @y / l, @z / l) : Vector3d.new(0, 0, 0)
      end

      def reverse
        Vector3d.new(-@x, -@y, -@z)
      end

      def cross(o)
        Vector3d.new(@y * o.z - @z * o.y, @z * o.x - @x * o.z, @x * o.y - @y * o.x)
      end

      def dot(o)
        @x * o.x + @y * o.y + @z * o.z
      end

      def transform(_tr)
        self # the transformations of these tests only move
      end
    end

    class Point3d
      attr_reader :x, :y, :z

      def initialize(x = 0.0, y = 0.0, z = 0.0)
        @x = x.to_f
        @y = y.to_f
        @z = z.to_f
      end

      def -(other)
        Vector3d.new(@x - other.x, @y - other.y, @z - other.z)
      end

      def +(other)
        Point3d.new(@x + other.x, @y + other.y, @z + other.z)
      end

      def distance(o)
        (self - o).length
      end

      def offset(vec, dist = nil)
        v = dist ? vec.normalize : vec
        k = dist ? dist.to_f : 1.0
        Point3d.new(@x + v.x * k, @y + v.y * k, @z + v.z * k)
      end

      def transform(tr)
        Point3d.new(@x + tr.dx, @y + tr.dy, @z + tr.dz)
      end

      def project_to_plane(plane)
        a, b, c, d = plane
        k = a * @x + b * @y + c * @z + d
        Point3d.new(@x - a * k, @y - b * k, @z - c * k)
      end
    end

    class Transformation
      attr_reader :dx, :dy, :dz

      def initialize(dx = 0.0, dy = 0.0, dz = 0.0)
        @dx = dx
        @dy = dy
        @dz = dz
      end

      def *(other)
        Transformation.new(@dx + other.dx, @dy + other.dy, @dz + other.dz)
      end

      def inverse
        Transformation.new(-@dx, -@dy, -@dz)
      end
    end
  end

  ORIGIN = Geom::Point3d.new(0, 0, 0)
  X_AXIS = Geom::Vector3d.new(1, 0, 0)
  Y_AXIS = Geom::Vector3d.new(0, 1, 0)
  Z_AXIS = Geom::Vector3d.new(0, 0, 1)

  module UI
  end

  module Sketchup
    class Layer
      attr_reader :name

      def initialize(name)
        @name = name
      end
    end
    LAYER0 = Layer.new('Layer0')

    class Group
      attr_reader :name, :layer, :entityID

      @@ids = 0
      def initialize(name, tag)
        @name = name
        @layer = tag ? Layer.new(tag) : LAYER0
        @entityID = (@@ids += 1)
      end

      def transformation
        Geom::Transformation.new
      end

      def get_attribute(_dict, _key)
        nil
      end
    end

    class Vertex
      attr_reader :position

      def initialize(p)
        @position = p
      end
    end

    class Edge
      attr_reader :start, :end, :faces

      def initialize(a, b)
        @start = a
        @end = b
        @faces = []
        @rev = {}
      end

      def use(face, reversed)
        @faces << face unless @faces.include?(face)
        @rev[face] = reversed
      end

      def reversed_in?(face)
        @rev[face]
      end
    end

    class Loop
      attr_reader :vertices, :edges

      def initialize(vertices, edges, outer)
        @vertices = vertices
        @edges = edges
        @outer = outer
      end

      def outer?
        @outer
      end
    end

    class Face
      PointInside = 1
      PointOutside = 16
      attr_reader :loops, :layer

      def initialize(loops)
        @loops = loops
        @layer = LAYER0
      end

      def outer_loop
        @loops[0]
      end

      def vertices
        @loops.map(&:vertices).flatten.uniq
      end

      def edges
        @loops.map(&:edges).flatten.uniq
      end

      def valid?
        true
      end

      def self.newell(pts)
        nx = ny = nz = 0.0
        pts.each_with_index do |p, i|
          q = pts[(i + 1) % pts.size]
          nx += (p.y - q.y) * (p.z + q.z)
          ny += (p.z - q.z) * (p.x + q.x)
          nz += (p.x - q.x) * (p.y + q.y)
        end
        Geom::Vector3d.new(nx, ny, nz)
      end

      def loop_points(lp)
        lp.vertices.map(&:position)
      end

      def normal
        Face.newell(loop_points(outer_loop)).normalize
      end

      def area(_tr = nil)
        a = Face.newell(loop_points(outer_loop)).length / 2.0
        @loops[1..-1].each { |lp| a -= Face.newell(loop_points(lp)).length / 2.0 }
        a
      end

      def plane
        n = normal
        p = outer_loop.vertices[0].position
        [n.x, n.y, n.z, -(n.x * p.x + n.y * p.y + n.z * p.z)]
      end

      # the two axes to look at the face along its normal
      def flat(p)
        n = normal
        ax = [n.x.abs, n.y.abs, n.z.abs]
        k = ax.index(ax.max)
        c = [p.x, p.y, p.z]
        c.delete_at(k)
        c
      end

      def self.inside2d?(pt, poly)
        x, y = pt
        inside = false
        poly.each_with_index do |a, i|
          b = poly[(i + 1) % poly.size]
          next unless (a[1] > y) != (b[1] > y)
          inside = !inside if x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
        end
        inside
      end

      def contains?(p)
        q = flat(p)
        return false unless Face.inside2d?(q, loop_points(outer_loop).map { |v| flat(v) })
        @loops[1..-1].none? { |lp| Face.inside2d?(q, loop_points(lp).map { |v| flat(v) }) }
      end

      def classify_point(p)
        contains?(p) ? PointInside : PointOutside
      end

      # a triangle of the face: an ear of its outline
      def mesh(_flags = 0)
        pts = loop_points(outer_loop)
        n = normal
        m = pts.size
        tri = nil
        m.times do |i|
          a = pts[(i - 1) % m]
          b = pts[i]
          c = pts[(i + 1) % m]
          turn = (b - a).cross(c - b)
          next unless turn.dot(n) > 1e-9
          ctr = Geom::Point3d.new((a.x + b.x + c.x) / 3.0, (a.y + b.y + c.y) / 3.0, (a.z + b.z + c.z) / 3.0)
          next unless contains?(ctr)
          tri = [a, b, c]
          break
        end
        t = tri || pts[0, 3]
        Struct.new(:tri) do
          def polygon_points_at(_i)
            tri
          end
        end.new(t)
      end
    end

    # The model: every face built in a test, for the ray tests.
    class Model
      attr_reader :world

      def initialize
        @world = []
      end

      def layers
        [LAYER0]
      end

      def raytest(ray, _wysiwyg = true)
        o, d = ray
        d = d.normalize
        best = nil
        @world.each do |group, face|
          a, b, c, k = face.plane
          den = a * d.x + b * d.y + c * d.z
          next if den.abs < 1e-9
          t = -(a * o.x + b * o.y + c * o.z + k) / den
          next if t < 1e-6
          p = Geom::Point3d.new(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)
          next unless face.contains?(p)
          best = [t, p, [group, face]] if best.nil? || t < best[0]
        end
        best ? [best[1], best[2]] : nil
      end
    end
    MODEL = Model.new

    def self.active_model
      MODEL
    end

    def self.read_default(_section, _key, default = nil)
      default
    end

    def self.version
      'offline'
    end

    def self.find_support_file(_name)
      nil
    end
  end

  # A group of faces sharing vertices and edges, built from points in mm.
  class Part
    attr_reader :faces, :group

    def initialize(name, tag)
      @group = Sketchup::Group.new(name, tag)
      @v = {}
      @e = {}
      @faces = []
    end

    def vertex(p)
      key = p.map { |c| (c * 100).round }
      @v[key] ||= Sketchup::Vertex.new(Geom::Point3d.new(p[0] / 25.4, p[1] / 25.4, p[2] / 25.4))
    end

    def ring(pts, outer)
      vs = pts.map { |p| vertex(p) }
      uses = []
      vs.each_with_index do |a, i|
        b = vs[(i + 1) % vs.size]
        key = [a, b].sort_by(&:object_id)
        e = (@e[key] ||= Sketchup::Edge.new(a, b))
        uses << [e, e.start != a]
      end
      [Sketchup::Loop.new(vs, uses.map(&:first), outer), uses]
    end

    def face(pts, holes = [])
      # as in SketchUp, an inner loop runs the other way round than the outer one
      turn = lambda { |poly| Sketchup::Face.newell(poly.map { |p| Geom::Point3d.new(*p) }) }
      n = turn.call(pts)
      holes = holes.map { |h| turn.call(h).dot(n) > 0 ? h.reverse : h }
      rings = [ring(pts, true)] + holes.map { |h| ring(h, false) }
      f = Sketchup::Face.new(rings.map(&:first))
      rings.each { |_lp, uses| uses.each { |e, rev| e.use(f, rev) } }
      @faces << f
      Sketchup::MODEL.world << [@group, f]
      f
    end

    def box(x0, y0, z0, w, d, h)
      x1 = x0 + w
      y1 = y0 + d
      z1 = z0 + h
      face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]])
      face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
      face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]])
      face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]])
      face([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]])
      face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]])
      self
    end

    # an outline in the XZ plane at y0 (with holes), pushed d towards +Y
    def slab(y0, d, outline, holes = [])
      at = lambda { |poly, y| poly.map { |x, z| [x, y, z] } }
      [y0, y0 + d].each { |y| face(at.call(outline, y), holes.map { |h| at.call(h, y) }) }
      ([outline] + holes).each do |poly|
        poly.each_with_index do |(xa, za), i|
          xb, zb = poly[(i + 1) % poly.size]
          face([[xa, y0, za], [xb, y0, zb], [xb, y0 + d, zb], [xa, y0 + d, za]])
        end
      end
      self
    end
  end

  src = File.read(MAIN, encoding: 'UTF-8')
  src = src.sub("require 'sketchup.rb'\n", '')
  cut = src.sub(/^    unless file_loaded\?\(__FILE__\)\n.*?^    end\n/m, '') # no menu, no server
  raise 'the menu block of main.rb was not found' if cut == src
  module_eval(cut, MAIN)
  E = KhuongDoan::SuMcp

  @pass = 0
  @fail = []
  def self.check(name, got, want, tol = 0.005)
    ok = want.is_a?(Numeric) ? (got.is_a?(Numeric) && (got - want).abs <= tol) : got == want
    ok ? @pass += 1 : @fail << "#{name}: got #{got.inspect}, expected #{want.inspect}"
    puts "#{ok ? 'PASS' : 'FAIL'}  #{name}#{ok ? '' : "  -> got #{got.inspect}, expected #{want.inspect}"}"
  end

  def self.ctx(min_ded = 0.0)
    E.mt_ctx({ 'min_deduction_m2' => min_ded, 'opening_codes' => %w[DR WN], 'real_codes' => %w[FL CL WL SK] }, 0.5, 600.0)
  end

  # Measure the parts given (each one piece on its own tag) in a fresh takeoff; the accumulators by tag.
  def self.measure(parts, min_ded = 0.0)
    c = ctx(min_ded)
    parts.each { |pt| E.mt_piece(pt.faces, Geom::Transformation.new, pt.group.layer.name, false, c, pt.group, '', pt.group) }
    E.mt_finish_runs(c)
    out = {}
    c['rows'].each { |(tag, _room), a| out[tag] = a }
    out
  end

  def self.fresh
    Sketchup::MODEL.world.clear
  end

  # ---- helpers of the engine
  check('tag_code: "FL-01 Oak floor" is code FL', E.tag_code('FL-01 Oak floor')[0], 'FL')
  check('mt_strip?: a face 12 x 4000 mm is the edge of a board', E.mt_strip?(12.mm * 4000.mm, 2 * (12.mm + 4000.mm)), true)
  check('mt_strip?: a mosaic tile 25 x 25 mm is not', E.mt_strip?(25.mm * 25.mm, 100.mm), false)

  # ---- boards and solids
  fresh
  r = measure([Part.new('floor', 'FL-01 T').box(0, 0, -12, 4000, 5000, 12)])['FL-01 T']
  check('floor board 4000 x 5000 x 12: 20.00 looking up', r['up'], 20.0)
  check('floor board: its 12 mm edges are not sides', r['box_low'] + r['box_tall'] + r['rise_up'], 0.0)
  check('floor board: plan area 20.00 (the measure of 1.5)', r['plan'], 20.0)

  # ---- single skins with a tall upright face (audit of 1.6.0, finding 1)
  fresh
  l = Part.new('L bulkhead', 'CL-21 T')
  l.face([[0, 0, 2300], [4000, 0, 2300], [4000, 0, 2700], [0, 0, 2700]])
  l.face([[0, 0, 2300], [4000, 0, 2300], [4000, 300, 2300], [0, 300, 2300]])
  pl = Part.new('platform skin', 'FL-21 T')
  pl.face([[0, 5000, 0], [2000, 5000, 0], [2000, 5000, 450], [0, 5000, 450]])
  pl.face([[0, 5000, 450], [2000, 5000, 450], [2000, 5300, 450], [0, 5300, 450]])
  r = measure([l, pl])
  a = r['CL-21 T']
  check('bulkhead as an L skin: soffit 1.20', a['down'], 1.2)
  check('bulkhead as an L skin: fascia 1.60 once (as an upright board, not also as a drop)', a['wall'] + a['rise_down'] + a['box_low'] + a['box_tall'], 1.6)
  a = r['FL-21 T']
  check('platform as a skin: top 0.60 + front 0.90 = 1.50', a['up'] + a['wall'] + a['rise_up'] + a['box_low'], 1.5)

  # ---- an open segmented wall is one surface (finding 2)
  fresh
  bay = Part.new('bay', 'WL-21 T')
  dx = 600 * Math.cos(30 * Math::PI / 180)
  [[0, 300, dx, 0], [dx, 0, dx + 2000, 0], [dx + 2000, 0, 2 * dx + 2000, 300]].each do |xa, ya, xb, yb|
    bay.face([[xa, ya, 0], [xb, yb, 0], [xb, yb, 2700], [xa, ya, 2700]])
  end
  a = measure([bay])['WL-21 T']
  check('splayed bay as one skin: 3.2 x 2.7 = 8.64', a['wall'], 8.64)
  check('splayed bay: nothing added as reveals, not reported as halved', [a['reveal'].round(3), a['not_straight'].size], [0.0, 0])

  # ---- exposed sides (findings 3 and 4)
  fresh
  bulk = Part.new('bulkhead', 'CL-23 T').box(0, 0, 2400, 4000, 300, 300)
  Part.new('floor', 'FL-29 T').box(0, 300, -12, 4000, 3000, 12)
  Part.new('shell', 'EX-21 T').face([[0, 3300, 0], [0, 3300, 2700], [4000, 3300, 2700], [4000, 3300, 0]]) # looks away from the room
  a = measure([bulk])['CL-23 T']
  check('box bulkhead over a floor, facing a wall drawn inside out: underside 1.20', a['down'], 1.2)
  check('box bulkhead: the one side over the floor counts, 1.20', a['box_low'] + a['box_tall'], 1.2)
  fresh
  a = measure([Part.new('bulkhead', 'CL-23 T').box(0, 0, 2400, 4000, 300, 300)])['CL-23 T']
  check('box bulkhead with no floor below: no side looks into a room', a['box_low'] + a['box_tall'], 0.0)
  fresh
  thick = Part.new('thick floor', 'FL-24 T').box(0, 0, 0, 4000, 3000, 50)
  Part.new('slab', 'EX-22 T').box(-500, -500, -200, 5000, 4000, 200)
  a = measure([thick])['FL-24 T']
  check('floor finish 50 thick on a larger slab: 12.00, its edges are not steps', a['up'] + a['box_low'] + a['rise_up'], 12.0)
  fresh
  low = Part.new('low platform', 'FL-25 T').box(1000, 1000, 0, 1000, 1000, 80)
  Part.new('floor', 'FL-26 T').box(0, 0, -12, 3000, 3000, 12)
  a = measure([low])['FL-25 T']
  check('platform 80 high on a floor finish: 1.00 + 4 x 0.08 = 1.32', a['up'] + a['box_low'], 1.32)
  fresh
  high = Part.new('platform', 'FL-14 T').box(1500, 1500, 0, 1000, 1000, 300)
  Part.new('slab', 'EX-23 T').box(0, 0, -200, 4000, 5000, 200)
  a = measure([high])['FL-14 T']
  check('platform 300 high over bare structure: its fronts count all the same, 1.00 + 1.20', a['up'] + a['box_low'], 2.2)

  # ---- openings and the deduction threshold
  fresh
  wall = Part.new('wall', 'WL-12 T').slab(0, 10, [[0, 0], [1000, 0], [1000, 2100], [1900, 2100], [1900, 0], [4000, 0], [4000, 2700], [0, 2700]],
                                          [[[2500, 1000], [2900, 1000], [2900, 1500], [2500, 1500]]])
  quarter = Part.new('wall', 'WL-22 T').slab(5000, 10, [[0, 0], [2000, 0], [2000, 2700], [0, 2700]], [[[500, 1000], [1000, 1000], [1000, 1500], [500, 1500]]])
  r = measure([wall, quarter], 0.25)
  a = r['WL-12 T']
  check('wall with a door notch and a hole: one side 8.71', a['wall'], 8.71)
  check('wall: 2 openings, 2.09 m2', [a['ow_n'], a['ow_a'].round(2)], [2, 2.09])
  check('wall: the 0.20 m2 hole is under the 0.25 threshold', [a['ow_sn'], a['ow_sa'].round(2)], [1, 0.2])
  a = r['WL-22 T']
  check('an opening of exactly 0.25 m2 is not under the threshold', [a['ow_n'], a['ow_sn']], [1, 0])

  # ---- a wall skin with a niche: its sides are reveals, the niche is not an opening
  fresh
  niche = Part.new('niche wall', 'WL-11 T')
  hole = [[1000, 0, 600], [2000, 0, 600], [2000, 0, 2100], [1000, 0, 2100]]
  niche.face([[0, 0, 0], [4000, 0, 0], [4000, 0, 2700], [0, 0, 2700]], [hole])
  niche.face(hole.map { |x, _y, z| [x, 250, z] })
  hole.each_with_index do |(xa, _ya, za), i|
    xb, _yb, zb = hole[(i + 1) % 4]
    niche.face([[xa, 0, za], [xb, 0, zb], [xb, 250, zb], [xa, 250, za]])
  end
  a = measure([niche])['WL-11 T']
  check('wall skin with a niche 1000 x 1500: 10.80 on its face', a['wall'], 10.8)
  check('niche: its four sides 250 deep are reveals, 1.25', a['reveal'], 1.25)
  check('niche: not an opening', a['ow_n'], 0)

  # ---- a casing wrapped round a column
  fresh
  col = Part.new('casing', 'WL-16 T')
  [[0, 0, 400, 0], [400, 0, 400, 400], [400, 400, 0, 400], [0, 400, 0, 0]].each do |xa, ya, xb, yb|
    col.face([[xa, ya, 0], [xb, yb, 0], [xb, yb, 2700], [xa, ya, 2700]])
  end
  a = measure([col])['WL-16 T']
  check('casing round a column 400 x 400: every face once, 4.32', a['wall'], 4.32)
  check('casing: reported as a wrapped surface', a['wrapped'].size, 1)

  # ---- a stepped ceiling as a single skin
  fresh
  skin = Part.new('stepped ceiling', 'CL-11 T')
  inner = [[600, 600], [3400, 600], [3400, 4400], [600, 4400]]
  skin.face([[0, 0, 2500], [4000, 0, 2500], [4000, 5000, 2500], [0, 5000, 2500]], [inner.map { |x, y| [x, y, 2500] }])
  skin.face(inner.reverse.map { |x, y| [x, y, 2800] }) # drawn the other way round
  inner.each_with_index do |(xa, ya), i|
    xb, yb = inner[(i + 1) % 4]
    skin.face([[xa, ya, 2500], [xb, yb, 2500], [xb, yb, 2800], [xa, ya, 2800]])
  end
  a = measure([skin])['CL-11 T']
  check('stepped ceiling as a skin: 20.00 flat', a['down'], 20.0)
  check('stepped ceiling: drops 13.2 m x 0.3 = 3.96', a['rise_down'], 3.96)

  # ---- lengths
  fresh
  nib = Part.new('nib', 'SK-21 T').box(0, 0, 0, 60, 12, 80)
  raked = Part.new('raked', 'SK-11 T').slab(1000, 12, [[0, 0], [4000, 2500], [4000, 2580], [0, 80]])
  run = Part.new('run', 'SK-31 T').box(0, 3000, 0, 3000, 12, 80)
  r = measure([nib, raked, run])
  check('skirting nib 60 long, 80 high: 0.06 m', r['SK-21 T']['length'], 0.06, 0.001)
  check('skirting up a stair (4000 going, 2500 rise): 4.72 m along the slope', r['SK-11 T']['length'], 4.717, 0.005)
  check('straight skirting 3000: 3.00 m', r['SK-31 T']['length'], 3.0, 0.001)

  # ---- a strip narrower than 30 mm that is the whole piece: its widest side is the surface
  fresh
  thr = Part.new('threshold', 'FL-27 T').box(0, 0, 0, 2000, 25, 10)
  Part.new('floor', 'FL-28 T').box(-500, -500, -12, 3000, 1000, 12)
  slat = Part.new('slat', 'WL-31 T').box(0, 5000, 0, 25, 12, 3000)
  r = measure([thr, slat])
  a = r['FL-27 T']
  check('threshold strip 2000 x 25 on a finished floor: 0.05, its edges are not steps', a['up'] + a['box_low'] + a['rise_up'], 0.05, 0.001)
  a = r['WL-31 T']
  check('wall slat 3000 x 25 x 12: one face, 0.075, its 12 mm edges are not reveals', a['wall'] + a['reveal'], 0.075, 0.001)

  # ---- review of 1.7.0
  fresh
  r = measure([Part.new('jamb trim', 'SK-41 T').box(0, 0, 0, 80, 12, 2100)])
  check('a trim on a skirting tag running up a jamb: 2.10 m, its longest size', r['SK-41 T']['length'], 2.1, 0.001)
  fresh
  shell = Part.new('curved shell', 'WL-41 T') # a panel 10 thick splayed in three parts, drawn as a solid without its underside
  front = [[0, 300], [dx, 0], [dx + 2000, 0], [2 * dx + 2000, 300]]
  ring = front + front.reverse.map { |x, y| [x, y + 10] }
  shell.face(ring.map { |x, y| [x, y, 2700] })
  ring.each_with_index do |(xa, ya), i|
    xb, yb = ring[(i + 1) % ring.size]
    shell.face([[xa, ya, 0], [xb, yb, 0], [xb, yb, 2700], [xa, ya, 2700]])
  end
  a = measure([shell])['WL-41 T']
  check('segmented wall panel as an open solid: half of its upright faces (8.67), reported as approximate', [a['wall'].round(2), a['not_straight'].size], [8.67, 1])
  fresh
  raft = Part.new('raft', 'CL-41 T').box(0, 0, 2400, 3000, 2000, 80)
  Part.new('floor', 'XX floor').box(-1000, -1000, -12, 5000, 4000, 12)
  a = measure([raft])['CL-41 T']
  check('ceiling raft 80 thick over a floor without an FL tag: its edges count, 6.00 + 0.80', a['down'] + a['box_low'], 6.8)
  fresh
  low = Part.new('low platform', 'FL-25 T').box(1000, 1000, 0, 1000, 1000, 80)
  Part.new('floor', 'FL-26 T').box(0, 0, -12, 3000, 3000, 12)
  Part.new('rug', 'FN-09 T').box(0, 0, 0, 3000, 3000, 5)
  a = measure([low])['FL-25 T']
  check('platform 80 high on a floor finish under furniture: still 1.32', a['up'] + a['box_low'], 1.32)
  fresh
  bulk = Part.new('bulkhead', 'CL-23 T').box(0, 0, 2400, 4000, 300, 300)
  Part.new('floor', 'FL-29 T').box(-4000, -1000, -12, 12000, 3000, 12)
  Part.new('partition', 'PA-01 T').box(4000, 0, 0, 3000, 300, 2700) # a solid in line with the bulkhead, against its end
  a = measure([bulk])['CL-23 T']
  check('box bulkhead with a long solid against one end: that end is hidden (1.20 + 2 long sides 2.40 + the free end 0.09)',
        a['down'] + a['box_low'] + a['box_tall'], 3.69)

  puts "\n#{@pass} PASS, #{@fail.size} FAIL"
  RESULT = { 'pass' => @pass, 'fail' => @fail }.freeze
end
exit(1) if !SuMcpOffline::RESULT['fail'].empty? && !defined?(::Sketchup)
