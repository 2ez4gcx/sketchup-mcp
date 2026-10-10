# SU MCP Bridge - main
# Socket server running inside SketchUp. Each connection sends 1 JSON line:
#   {"id": 1, "cmd": "model_info", "params": {...}}\n
# and receives 1 JSON line back:
#   {"id": 1, "ok": true, "result": ...}\n   or   {"id": 1, "ok": false, "error": "..."}\n
# Listens on 127.0.0.1 only (never exposed to the network).
# Exchange units: mm (length), m2 (area), m3 (volume).
# Log (command name, duration, errors; parameters/code are not logged - error messages may contain file names): <Sketchup.temp_dir>/su_mcp.log - menu Extensions > SU MCP Bridge > Open log file.
# The source keeps Ruby 2.2 syntax so it runs on SketchUp 2017 -> 2026.
require 'sketchup.rb'
require 'socket'
require 'json'
require 'stringio'
require 'tmpdir'
require 'fileutils'

module KhuongDoan
  module SuMcp
    VERSION      = '1.2.0'.freeze
    HOST         = '127.0.0.1'.freeze
    DEFAULT_PORT = 9876
    IN_TO_MM     = 25.4
    IN2_TO_M2    = 0.00064516
    IN3_TO_M3    = 1.6387064e-05
    MAX_TEXT     = 50_000
    MAX_REQUEST  = 16 * 1024 * 1024
    LOG_MAX      = 1_000_000

    def self.valid_port(v)
      n = begin
        Integer(v.to_s)
      rescue StandardError
        nil
      end
      return n if n && n >= 1024 && n <= 65_535
      @port_warning = "Configured port '#{v}' is invalid (1024-65535), using #{DEFAULT_PORT}."
      DEFAULT_PORT
    end

    PORT = valid_port(Sketchup.read_default('SuMcp', 'port', DEFAULT_PORT)) unless const_defined?(:PORT, false)

    # Keep state when the file is reloaded (load) while SketchUp is running.
    @server     = nil unless defined?(@server)
    @timer      = nil unless defined?(@timer)
    @busy       = false unless defined?(@busy)
    @last_error = nil unless defined?(@last_error)
    @last_cmd   = nil unless defined?(@last_cmd)

    # ------------------------------------------------------------------
    # Server lifecycle
    # ------------------------------------------------------------------
    def self.running?
      !@server.nil?
    end

    # manual = true when clicked from the menu: show errors in a message box (at SketchUp startup only record them, no popup).
    def self.start(manual = false)
      return true if running?
      @server = TCPServer.new(HOST, PORT)
      @timer  = UI.start_timer(0.1, true) { poll }
      @last_error = nil
      status_text("running #{HOST}:#{PORT}")
      log("start #{HOST}:#{PORT} bridge=#{VERSION} sketchup=#{Sketchup.version} ruby=#{RUBY_VERSION}")
      puts "[SU MCP] Listening on #{HOST}:#{PORT}"
      true
    rescue StandardError => e
      @server = nil
      @last_error =
        if e.is_a?(Errno::EADDRINUSE)
          "Port #{PORT} is used by another SketchUp window (or another program). " \
          "Claude is controlling that window (ask Claude to 'ping' to see the model name). " \
          'To use this window: close the other one, then click Extensions > SU MCP Bridge > Start server.'
        elsif e.is_a?(Errno::EACCES)
          "Windows does not allow port #{PORT} (it may be in a range reserved by Windows/Hyper-V: " \
          "'netsh interface ipv4 show excludedportrange protocol=tcp'). Change the port: Extensions > SU MCP Bridge > Change port..."
        else
          "Could not start the server: #{e.class}: #{e.message}"
        end
      log("start_failed #{e.class}: #{e.message}")
      puts "[SU MCP] #{@last_error}"
      UI.messagebox(@last_error) if manual
      false
    end

    def self.stop
      UI.stop_timer(@timer) if @timer
      @timer = nil
      begin
        @server.close if @server
      rescue StandardError
        nil
      end
      @server = nil
      status_text('stopped')
      log('stop')
      puts '[SU MCP] Stopped.'
    end

    def self.poll
      return if @busy || @server.nil?
      begin
        client = @server.accept_nonblock
      rescue IO::WaitReadable, Errno::EINTR, Errno::EAGAIN
        return
      end
      @busy = true
      begin
        handle_client(client)
      ensure
        @busy = false
      end
    rescue NoMemoryError, SignalException
      raise
    rescue Exception => e # rubocop:disable Lint/RescueException
      puts "[SU MCP] Poll error: #{e.class}: #{e.message}"
    end

    # Read 1 request line: at most `total` seconds in total and at most MAX_REQUEST bytes,
    # so a stray connection (e.g. a port scan) cannot freeze SketchUp.
    def self.read_line(client, total = 5)
      buf = String.new
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + total
      loop do
        left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        raise 'Timed out waiting for request data from client' if left <= 0
        raise 'Timed out waiting for request data from client' unless IO.select([client], nil, nil, left)
        begin
          buf << client.readpartial(65_536)
        rescue EOFError
          break
        end
        raise 'Request too large' if buf.bytesize > MAX_REQUEST
        break if buf.include?("\n")
      end
      buf.force_encoding('UTF-8').split("\n", 2).first.to_s
    end

    # Always reply and always close the socket, even when run_ruby code calls exit/recurses infinitely
    # or the result contains non-UTF-8 strings (TCVN3/VNI...).
    def self.handle_client(client)
      req_id = nil
      cmd = nil
      code_size = nil
      t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      begin
        begin
          req = JSON.parse(read_line(client))
          req_id = req['id']
          cmd = req['cmd'].to_s
          params = req['params'] || {}
          code_size = params['code'].to_s.size if cmd == 'run_ruby'
          resp = { 'id' => req_id, 'ok' => true, 'result' => dispatch(cmd, params) }
        rescue NoMemoryError, SignalException
          raise
        rescue Exception => e # rubocop:disable Lint/RescueException
          full = e.backtrace || []
          bt = (full[0, 5] + full.grep(/\Amcp_run_ruby:/).first(3)).uniq.map { |l| utf8(l) }
          resp = { 'id' => req_id, 'ok' => false, 'error' => utf8("#{e.class}: #{e.message}"), 'backtrace' => bt }
        end
        out = begin
          JSON.generate(resp)
        rescue StandardError => e
          resp = { 'id' => req_id.is_a?(Integer) ? req_id : nil, 'ok' => false,
                   'error' => "Command '#{utf8(cmd)}' HAS RUN in SketchUp but its result could not be sent " \
                              "(#{e.class}: #{utf8(e.message)[0, 200]}). Do not run it again; call model_info/selection_info to check." }
          JSON.generate(resp)
        end
        begin
          client.write(out + "\n")
        rescue StandardError => e
          puts "[SU MCP] Could not send response: #{e.message}"
        end
        ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round
        @last_cmd = [cmd || '?', Time.now, resp['ok'] ? true : false, ms]
        detail = resp['ok'] ? 'ok' : "ERR #{resp['error'].to_s[0, 300]}"
        log("#{cmd || '?'} #{ms}ms #{detail}#{code_size ? " code_chars=#{code_size}" : ''}")
      ensure
        begin
          client.close
        rescue StandardError
          nil
        end
      end
    end

    # ------------------------------------------------------------------
    # Diagnostics: status bar, log, status dialog
    # ------------------------------------------------------------------
    def self.status_text(text)
      Sketchup.status_text = "SU MCP: #{text}"
    rescue StandardError
      nil
    end

    def self.log_path
      dir = begin
        Sketchup.temp_dir
      rescue StandardError
        Dir.tmpdir
      end
      File.join(dir, 'su_mcp.log')
    end

    # Write with File (not puts, because run_ruby temporarily replaces $stdout). Never breaks a command.
    def self.log(line)
      path = log_path
      begin
        if File.exist?(path) && File.size(path) > LOG_MAX
          File.delete(path + '.1') if File.exist?(path + '.1')
          File.rename(path, path + '.1')
        end
      rescue StandardError
        nil # file is open/locked: keep appending to the current file
      end
      File.open(path, 'a:UTF-8') { |f| f.puts("#{Time.now.strftime('%Y-%m-%d %H:%M:%S')} #{utf8(line)}") }
    rescue StandardError => e
      unless @log_warned
        @log_warned = true
        warn "[SU MCP] Could not write log #{path}: #{e.message}"
      end
    end

    def self.status_report
      title = model ? utf8(model.title) : ''
      lines = [running? ? "SU MCP Bridge v#{VERSION}: RUNNING on #{HOST}:#{PORT}" : "SU MCP Bridge v#{VERSION}: STOPPED"]
      lines << "Model: #{title.empty? ? '(untitled)' : title}"
      lines << "Startup error: #{@last_error}" if @last_error
      lines << "Warning: #{@port_warning}" if @port_warning
      if @last_cmd
        c, t, ok, ms = @last_cmd
        lines << "Last command: #{c} at #{t.strftime('%H:%M:%S')} (#{ok ? 'OK' : 'ERROR'}, #{ms} ms)"
      end
      lines << "Log file: #{log_path}"
      lines.join("\n")
    end

    def self.open_log
      path = log_path
      if File.exist?(path)
        UI.openURL('file:///' + path.tr('\\', '/'))
      else
        UI.messagebox("No log file yet: #{path}")
      end
    end

    # Change the bridge port (saved in SketchUp preferences); requires restarting SketchUp and setting the same port in Claude.
    def self.change_port_dialog
      res = UI.inputbox(['Port (1024-65535):'], [PORT.to_s], 'SU MCP Bridge - Change port')
      return unless res
      n = begin
        Integer(res[0].to_s.strip)
      rescue StandardError
        nil
      end
      unless n && n >= 1024 && n <= 65_535
        UI.messagebox('Invalid port (1024-65535).')
        return
      end
      Sketchup.write_default('SuMcp', 'port', n)
      log("port_changed #{PORT} -> #{n}")
      UI.messagebox("Port #{n} saved.\n1) Fully quit and reopen SketchUp.\n" \
                    "2) In Claude: Settings > Extensions > SketchUp MCP > Configure, set port #{n}.")
    end

    COMMANDS = %w[
      ping model_info list_tags list_components list_materials selection_info
      quantity_takeoff create_box create_shape create_lines insert_component
      transform_entities set_material set_tag delete_entities select_entities
      set_view export_png export_file save_model open_model new_model undo run_ruby
    ].freeze

    def self.dispatch(cmd, params)
      raise ArgumentError, "Unsupported command: #{cmd}. Available commands: #{COMMANDS.join(', ')}" unless COMMANDS.include?(cmd)
      send("cmd_#{cmd}", params)
    end

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def self.model
      Sketchup.active_model
    end

    def self.mm(v)
      v.to_f.mm
    end

    def self.to_mm(v)
      (v.to_f * IN_TO_MM).round(2)
    end

    def self.pt_mm(p)
      [to_mm(p.x), to_mm(p.y), to_mm(p.z)]
    end

    def self.point(arr)
      raise ArgumentError, "Point must be [x,y,z] (mm), got: #{arr.inspect}" unless arr.is_a?(Array) && arr.size >= 2
      Geom::Point3d.new(mm(arr[0]), mm(arr[1]), mm(arr[2] || 0))
    end

    def self.bounds_mm(bb)
      return nil if bb.nil? || bb.empty?
      { 'min' => pt_mm(bb.min), 'max' => pt_mm(bb.max),
        'size' => [to_mm(bb.width), to_mm(bb.height), to_mm(bb.depth)] }
    end

    # Tag as UTF-8 and replace invalid bytes with '?' (e.g. TCVN3/VNI files) so JSON.generate does not fail.
    def self.utf8(s)
      s.to_s.dup.force_encoding('UTF-8').scrub('?')
    end

    # Create the parent folder if missing (e.g. D:/Export/...) before exporting a file.
    def self.ensure_parent_dir(path)
      dir = File.dirname(path.to_s)
      FileUtils.mkdir_p(dir) unless dir.empty? || File.directory?(dir)
    end

    def self.untagged?(layer)
      layer.nil? || layer.name == 'Layer0' || layer == model.layers[0]
    end

    def self.tag_name(layer)
      untagged?(layer) ? 'Untagged' : utf8(layer.name)
    end

    def self.with_operation(name)
      m = model
      m.start_operation("MCP: #{name}", true)
      begin
        r = yield m
        m.commit_operation
        r
      rescue Exception # rubocop:disable Lint/RescueException
        begin
          m.abort_operation
        rescue StandardError
          nil
        end
        raise
      end
    end

    def self.find_entities(params)
      ids = params['entity_ids']
      if ids.nil? || ids.empty?
        sel = model.selection.to_a
        raise ArgumentError, 'No entity_ids given and nothing is selected' if sel.empty?
        return sel
      end
      Array(ids).map do |id|
        e = model.find_entity_by_id(id.to_i)
        raise ArgumentError, "Entity id #{id} not found" if e.nil?
        e
      end
    end

    # Only set the color when the material was just created, or when update_existing is passed explicitly:
    # avoids recoloring an existing material (which may have a texture) on EVERY surface of the model.
    def self.get_material(name, color = nil, update_existing = false)
      return nil if name.nil? || name.to_s.empty?
      mats = model.materials
      mat = mats[name.to_s]
      created = mat.nil?
      mat = mats.add(name.to_s) if created
      mat.color = Sketchup::Color.new(color.to_s) if color && !color.to_s.empty? && (created || update_existing)
      mat
    end

    def self.get_tag(name)
      return nil if name.nil? || name.to_s.empty?
      model.layers[name.to_s] || model.layers.add(name.to_s)
    end

    def self.apply_common(ent, params)
      ent.name = params['name'].to_s if params['name'] && ent.respond_to?(:name=)
      tag = get_tag(params['tag'])
      ent.layer = tag if tag
      mat = get_material(params['material'], params['color'])
      ent.material = mat if mat
      ent
    end

    def self.material_existed?(p)
      !p['material'].to_s.empty? && !model.materials[p['material'].to_s].nil?
    end

    # Result of create_*: adds a note when color was ignored because the material already exists.
    def self.create_result(ent, p, existed)
      s = entity_summary(ent)
      if existed && p['color'] && !p['color'].to_s.empty?
        s['note'] = "Material '#{utf8(p['material'])}' already exists, its color was kept; to recolor the material itself " \
                    'use set_material with update_existing=true.'
      end
      s
    end

    def self.entity_summary(e)
      h = { 'id' => e.entityID, 'type' => e.typename }
      h['persistent_id'] = e.persistent_id if e.respond_to?(:persistent_id)
      h['tag'] = tag_name(e.layer) if e.respond_to?(:layer)
      if e.respond_to?(:material)
        h['material'] = e.material ? utf8(e.material.display_name) : nil
      end
      h['hidden'] = e.hidden? if e.respond_to?(:hidden?)
      case e
      when Sketchup::Group
        h['name'] = utf8(e.name)
        h['bounds_mm'] = bounds_mm(e.bounds)
        v = e.volume
        h['volume_m3'] = (v * IN3_TO_M3).round(6) if v && v > 0
      when Sketchup::ComponentInstance
        h['name'] = utf8(e.name)
        h['definition'] = utf8(e.definition.name)
        h['bounds_mm'] = bounds_mm(e.bounds)
        v = e.volume
        h['volume_m3'] = (v * IN3_TO_M3).round(6) if v && v > 0
      when Sketchup::Face
        h['area_m2'] = (e.area * IN2_TO_M2).round(6)
        h['normal'] = e.normal.to_a.map { |c| c.round(4) }
      when Sketchup::Edge
        h['length_mm'] = to_mm(e.length)
      end
      h
    end

    # ------------------------------------------------------------------
    # Read / statistics commands
    # ------------------------------------------------------------------
    def self.cmd_ping(_p)
      { 'bridge' => VERSION, 'sketchup' => Sketchup.version, 'ruby' => RUBY_VERSION,
        'port' => PORT, 'model' => utf8(model.title) }
    end

    def self.cmd_model_info(_p)
      m = model
      ents = m.entities
      unit_names = %w[inch feet mm cm m yard]
      unit_idx = m.options['UnitsOptions']['LengthUnit'] rescue nil
      {
        'title' => utf8(m.title),
        'path' => utf8(m.path),
        'modified' => m.modified?,
        'length_unit' => unit_idx ? unit_names[unit_idx] : nil,
        'bounds_mm' => bounds_mm(m.bounds),
        'top_level' => {
          'total' => ents.size,
          'groups' => ents.grep(Sketchup::Group).size,
          'components' => ents.grep(Sketchup::ComponentInstance).size,
          'faces' => ents.grep(Sketchup::Face).size,
          'edges' => ents.grep(Sketchup::Edge).size
        },
        'tags' => m.layers.size,
        'materials' => m.materials.size,
        'definitions' => m.definitions.reject { |d| d.group? || d.image? }.size,
        'selection' => m.selection.size,
        'scenes' => m.pages.map { |pg| utf8(pg.name) }
      }
    end

    def self.cmd_list_tags(_p)
      counts = Hash.new(0)
      model.definitions.each do |d|
        next if d.image?
        d.entities.each { |e| counts[e.layer] += 1 if e.respond_to?(:layer) }
      end
      model.entities.each { |e| counts[e.layer] += 1 if e.respond_to?(:layer) }
      model.layers.map do |l|
        { 'name' => tag_name(l), 'visible' => l.visible?, 'entity_count' => counts[l],
          'color' => l.color ? l.color.to_a[0, 3] : nil }
      end
    end

    def self.cmd_list_components(p)
      include_groups = p['include_groups'] ? true : false
      defs = model.definitions.reject { |d| d.image? || (d.group? && !include_groups) }
      defs.map do |d|
        { 'name' => utf8(d.name), 'is_group' => d.group?, 'description' => utf8(d.description),
          'instances' => d.count_used_instances, 'bounds_mm' => bounds_mm(d.bounds) }
      end.sort_by { |h| -h['instances'] }
    end

    def self.cmd_list_materials(_p)
      model.materials.map do |m|
        { 'name' => utf8(m.name), 'display_name' => utf8(m.display_name),
          'color' => m.color.to_a[0, 3], 'alpha' => m.alpha,
          'texture' => m.texture ? utf8(File.basename(m.texture.filename.to_s)) : nil }
      end
    end

    def self.cmd_selection_info(p)
      limit = [(p['limit'] || 200).to_i, 0].max
      sel = model.selection.to_a
      { 'count' => sel.size, 'items' => sel.first(limit).map { |e| entity_summary(e) } }
    end

    # Quantity takeoff: walks the whole model recursively, sums face area (m2),
    # edge length (m), solid volume (m3) and counts components per tag or material.
    # "Untagged" tag / no material is inherited from the parent group/component.
    def self.cmd_quantity_takeoff(p)
      by = (p['group_by'] || 'tag').to_s
      raise ArgumentError, 'group_by must be "tag" or "material"' unless %w[tag material].include?(by)
      include_hidden = p['include_hidden'] ? true : false
      only_selection = p['selection_only'] ? true : false
      stats = Hash.new do |h, k|
        h[k] = { 'face_area_m2' => 0.0, 'faces' => 0, 'edge_length_m' => 0.0,
                 'solid_volume_m3' => 0.0, 'solids' => 0, 'instances' => Hash.new(0) }
      end
      roots = only_selection ? model.selection.to_a : model.entities.to_a
      walk(roots, IDENTITY, 'Untagged', nil, include_hidden, by, stats)
      out = {}
      stats.each do |k, s|
        out[k] = {
          'face_area_m2' => s['face_area_m2'].round(4),
          'faces' => s['faces'],
          'edge_length_m' => s['edge_length_m'].round(4),
          'solid_volume_m3' => s['solid_volume_m3'].round(6),
          'solids' => s['solids'],
          'instances' => s['instances']
        }
      end
      { 'group_by' => by, 'groups' => out,
        'note' => 'face_area_m2 = total area of ALL faces (each face counted once): a solid includes its top, bottom and side faces, ' \
                  'so this is NOT floor area. Floor area = sum of upward-facing horizontal faces (use run_ruby if needed). ' \
                  'Volume is only computed for groups/components that are solids.' }
    end

    IDENTITY = Geom::Transformation.new

    def self.walk(ents, tr, tag, mat, include_hidden, by, stats)
      ents.each do |e|
        next unless e.is_a?(Sketchup::Drawingelement)
        next if !include_hidden && (e.hidden? || !e.layer.visible?)
        etag = untagged?(e.layer) ? tag : utf8(e.layer.name)
        emat = e.respond_to?(:material) && e.material ? utf8(e.material.display_name) : mat
        key = by == 'tag' ? etag : (emat || '(no material)')
        case e
        when Sketchup::Face
          stats[key]['face_area_m2'] += e.area(tr) * IN2_TO_M2
          stats[key]['faces'] += 1
        when Sketchup::Edge
          a = e.start.position.transform(tr)
          b = e.end.position.transform(tr)
          stats[key]['edge_length_m'] += a.distance(b) * IN_TO_MM / 1000.0
        when Sketchup::Group, Sketchup::ComponentInstance
          dname = e.is_a?(Sketchup::Group) ? "[Group] #{utf8(e.name)}" : utf8(e.definition.name)
          stats[key]['instances'][dname] += 1
          v = e.volume
          if v && v > 0
            stats[key]['solid_volume_m3'] += v * IN3_TO_M3
            stats[key]['solids'] += 1
          end
          walk(e.definition.entities, tr * e.transformation, etag, emat, include_hidden, by, stats)
        end
      end
    end

    # ------------------------------------------------------------------
    # Modelling commands (each command = 1 Undo step)
    # ------------------------------------------------------------------
    def self.cmd_create_box(p)
      w = mm(p['width']); d = mm(p['depth']); h = mm(p['height'])
      raise ArgumentError, 'width, depth, height must be > 0 (mm)' unless w > 0 && d > 0 && h > 0
      o = point(p['origin'] || [0, 0, 0])
      existed = material_existed?(p)
      with_operation('create_box') do |m|
        g = m.active_entities.add_group
        pts = [o, o.offset([w, 0, 0]), o.offset([w, d, 0]), o.offset([0, d, 0])]
        f = g.entities.add_face(pts)
        f.reverse! if f.normal.z < 0
        f.pushpull(h)
        apply_common(g, p)
        create_result(g, p, existed)
      end
    end

    # Draw 1 face from a polygon (mm), optional pushpull (mm) to make a solid.
    def self.cmd_create_shape(p)
      pts = Array(p['points']).map { |a| point(a) }
      raise ArgumentError, 'At least 3 points required' if pts.size < 3
      existed = material_existed?(p)
      with_operation('create_shape') do |m|
        g = m.active_entities.add_group
        f = g.entities.add_face(pts)
        raise 'Could not create a face (are the points coplanar?)' if f.nil?
        if p['pushpull'] && p['pushpull'].to_f != 0
          f.reverse! if f.normal.z < 0
          f.pushpull(mm(p['pushpull']))
        end
        apply_common(g, p)
        create_result(g, p, existed)
      end
    end

    # close_face=true: create a face from the points (SketchUp generates the closed edges itself); if no face can be
    # created (not coplanar) only a closed polyline is drawn. Reports face_created. (add_face(edge array) is not used: SketchUp may delete the whole group.)
    def self.cmd_create_lines(p)
      pts = Array(p['points']).map { |a| point(a) }
      raise ArgumentError, 'At least 2 points required' if pts.size < 2
      close = p['close_face'] ? true : false
      ring = pts.size > 3 && pts.first == pts.last ? pts[0...-1] : pts
      with_operation('create_lines') do |m|
        g = m.active_entities.add_group
        face = nil
        if close && ring.size >= 3
          face = begin
            g.entities.add_face(ring)
          rescue StandardError
            nil
          end
          g.entities.add_edges(ring + [ring.first]) unless face
        else
          g.entities.add_edges(pts)
        end
        apply_common(g, p)
        s = create_result(g, p, false)
        s['face_created'] = face ? true : false if close
        s
      end
    end

    def self.cmd_insert_component(p)
      path = p['path'].to_s
      existed = material_existed?(p)
      with_operation('insert_component') do |m|
        defn = if !path.empty?
                 raise ArgumentError, "File not found: #{path}" unless File.exist?(path)
                 m.definitions.load(path)
               else
                 m.definitions[p['definition'].to_s] || raise(ArgumentError, "Definition '#{p['definition']}' not found")
               end
        tr = Geom::Transformation.new(point(p['position'] || [0, 0, 0]))
        if p['rotation_deg'] && p['rotation_deg'].to_f != 0
          tr = tr * Geom::Transformation.rotation(ORIGIN, Z_AXIS, p['rotation_deg'].to_f.degrees)
        end
        inst = m.active_entities.add_instance(defn, tr)
        apply_common(inst, p)
        create_result(inst, p, existed)
      end
    end

    # translate [dx,dy,dz] mm; rotate_deg around the Z axis at pivot (mm); scale is a uniform factor.
    def self.cmd_transform_entities(p)
      ents = find_entities(p)
      with_operation('transform') do |m|
        tr = Geom::Transformation.new
        pivot = p['pivot'] ? point(p['pivot']) : nil
        if p['scale'] && p['scale'].to_f != 1 && p['scale'].to_f > 0
          sp = pivot || ents.first.bounds.center
          tr = Geom::Transformation.scaling(sp, p['scale'].to_f) * tr
        end
        if p['rotate_deg'] && p['rotate_deg'].to_f != 0
          rp = pivot || ents.first.bounds.center
          axis = p['axis'] ? Geom::Vector3d.new(*p['axis'].map(&:to_f)) : Z_AXIS
          tr = Geom::Transformation.rotation(rp, axis, p['rotate_deg'].to_f.degrees) * tr
        end
        if p['translate']
          t = p['translate']
          tr = Geom::Transformation.translation(Geom::Vector3d.new(mm(t[0]), mm(t[1]), mm(t[2] || 0))) * tr
        end
        m.active_entities.transform_entities(tr, ents)
        ents.map { |e| entity_summary(e) }
      end
    end

    def self.cmd_set_material(p)
      ents = find_entities(p)
      existed = !model.materials[p['material'].to_s].nil?
      update = p['update_existing'] == true
      with_operation('set_material') do |_m|
        mat = get_material(p['material'], p['color'], update)
        raise ArgumentError, 'Missing material name' unless mat
        ents.each do |e|
          e.material = mat if e.respond_to?(:material=)
          e.back_material = mat if p['back_too'] && e.respond_to?(:back_material=)
        end
        has_color = p['color'] && !p['color'].to_s.empty?
        inner = ents.inject(0) do |n, e|
          next n unless e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
          n + e.definition.entities.grep(Sketchup::Face).count { |f| f.material }
        end
        h = { 'material' => utf8(mat.display_name), 'count' => ents.size,
              'material_existed' => existed, 'color_applied' => (has_color && (!existed || update)) ? true : false }
        if has_color && existed && !update
          h['note'] = 'The material already exists, so its color was NOT changed (to avoid affecting every object that uses it). ' \
                      'To recolor the material itself, call again with update_existing=true.'
        end
        if inner > 0
          h['inner_faces_with_own_material'] = inner
          h['note_inner'] = "#{inner} faces inside groups/components have their own material and keep their color."
        end
        h
      end
    end

    def self.cmd_set_tag(p)
      ents = find_entities(p)
      with_operation('set_tag') do |_m|
        tag = get_tag(p['tag'])
        raise ArgumentError, 'Missing tag name' unless tag
        ents.each { |e| e.layer = tag if e.respond_to?(:layer=) }
        { 'tag' => tag_name(tag), 'count' => ents.size }
      end
    end

    def self.cmd_delete_entities(p)
      raise ArgumentError, 'entity_ids are required for delete' if Array(p['entity_ids']).empty?
      ents = find_entities(p)
      with_operation('delete') do |m|
        m.active_entities.erase_entities(ents)
        { 'deleted' => ents.size }
      end
    end

    def self.cmd_select_entities(p)
      sel = model.selection
      sel.clear if p['clear'] != false
      ids = Array(p['entity_ids'])
      ids.each do |id|
        e = model.find_entity_by_id(id.to_i)
        sel.add(e) if e
      end
      { 'selected' => sel.size }
    end

    # ------------------------------------------------------------------
    # View & export
    # ------------------------------------------------------------------
    VIEW_DIRS = {
      'iso'    => [[-1, -1, 1], Z_AXIS],
      'top'    => [[0, 0, 1], Y_AXIS],
      'bottom' => [[0, 0, -1], Y_AXIS],
      'front'  => [[0, -1, 0], Z_AXIS],
      'back'   => [[0, 1, 0], Z_AXIS],
      'left'   => [[-1, 0, 0], Z_AXIS],
      'right'  => [[1, 0, 0], Z_AXIS]
    }.freeze

    def self.cmd_set_view(p)
      name = (p['view'] || 'iso').to_s
      cfg = VIEW_DIRS[name] or raise ArgumentError, "view must be one of: #{VIEW_DIRS.keys.join(', ')}"
      view = model.active_view
      bb = model.bounds
      target = bb.empty? ? ORIGIN : bb.center
      dist = bb.empty? ? 1000.mm : [bb.diagonal, 1.mm].max * 2
      dir = Geom::Vector3d.new(*cfg[0]); dir.normalize!
      eye = target.offset(dir, dist)
      cam = Sketchup::Camera.new(eye, target, cfg[1])
      cam.perspective = p.key?('perspective') ? (p['perspective'] ? true : false) : (name == 'iso')
      view.camera = cam
      view.zoom_extents if p['zoom_extents'] != false
      view.invalidate
      { 'view' => name, 'perspective' => cam.perspective? }
    end

    # restore_view=true (used by the screenshot tool): change the view temporarily for the capture, then restore the old camera,
    # so the view the user is working in does not change.
    # max_size: longest side (px), keeps the viewport aspect ratio; if absent, width/height are used.
    def self.cmd_export_png(p)
      path = p['path'].to_s
      raise ArgumentError, 'Missing path (e.g. D:/out/view.png)' if path.empty?
      view = model.active_view
      snap = nil
      if p['restore_view'] == true && p['view']
        c = view.camera
        if c.respond_to?(:is_2d?) && c.is_2d?
          raise ArgumentError, '2D/Match Photo camera: the view cannot be restored; omit the view parameter'
        end
        snap = Sketchup::Camera.new(c.eye, c.target, c.up)
        snap.perspective = c.perspective?
        if c.perspective?
          snap.fov = c.fov
        else
          snap.height = c.height
        end
        snap.aspect_ratio = c.aspect_ratio if c.respond_to?(:aspect_ratio) && snap.respond_to?(:aspect_ratio=)
      end
      ensure_parent_dir(path)
      w = h = nil
      ok = false
      begin
        cmd_set_view(p) if p['view']
        vw = view.vpwidth
        vh = view.vpheight
        if p['max_size']
          ms = [[p['max_size'].to_i, 64].max, 4096].min
          k = ms.to_f / [vw, vh].max
          w = (vw * k).round
          h = (vh * k).round
        else
          w = (p['width'] || vw).to_i
          h = (p['height'] || vh).to_i
        end
        raise ArgumentError, "Invalid image size: #{w}x#{h}" unless w.between?(1, 16_384) && h.between?(1, 16_384)
        ok = view.write_image(:filename => path, :width => w, :height => h, :antialias => true,
                              :transparent => p['transparent'] ? true : false)
      ensure
        if snap
          view.camera = snap, 0
          view.invalidate
        end
      end
      { 'ok' => ok ? true : false, 'path' => path, 'exists' => File.exist?(path),
        'size_bytes' => File.exist?(path) ? File.size(path) : 0,
        'width' => w, 'height' => h, 'view' => (p['view'] || 'current').to_s, 'restored' => snap ? true : false }
    end

    def self.cmd_export_file(p)
      path = p['path'].to_s
      raise ArgumentError, 'Missing path' if path.empty?
      ensure_parent_dir(path)
      ok = model.export(path, false)
      { 'ok' => ok ? true : false, 'path' => path, 'exists' => File.exist?(path),
        'note' => 'The format follows the file extension (dae, obj, stl, dwg, dxf, 3ds, ...). Some formats require SketchUp Pro.' }
    end

    def self.cmd_save_model(p)
      path = p['path'].to_s
      ok = path.empty? ? model.save : model.save(path)
      { 'ok' => ok ? true : false, 'path' => utf8(model.path) }
    end

    def self.cmd_open_model(p)
      path = p['path'].to_s
      raise ArgumentError, "File not found: #{path}" unless File.exist?(path)
      ok = Sketchup.open_file(path)
      { 'ok' => ok ? true : false, 'title' => utf8(model.title) }
    end

    def self.cmd_new_model(_p)
      Sketchup.file_new
      { 'ok' => true }
    end

    def self.cmd_undo(_p)
      Sketchup.send_action('editUndo:')
      { 'ok' => true }
    end

    # Run arbitrary Ruby inside SketchUp (like AutoCAD's run_lisp).
    # The whole code is 1 Undo step. Returns the last value + the puts output.
    def self.cmd_run_ruby(p)
      code = p['code'].to_s
      raise ArgumentError, 'Missing code' if code.strip.empty?
      out = StringIO.new
      old = $stdout
      result = nil
      begin
        $stdout = out
        result = with_operation('run_ruby') do |_m|
          begin
            eval(code, TOPLEVEL_BINDING, 'mcp_run_ruby', 1) # rubocop:disable Security/Eval
          rescue NoMemoryError, SignalException, StandardError, ScriptError
            raise
          rescue SystemExit => e
            raise RuntimeError, 'run_ruby must not call exit/abort (SystemExit) - changes were rolled back', e.backtrace
          rescue Exception => e # rubocop:disable Lint/RescueException
            # e.g. SystemStackError (infinite recursion): convert to a regular error so Claude is told right away
            raise RuntimeError, "#{e.class}: #{e.message}", e.backtrace
          end
        end
      ensure
        $stdout = old
      end
      text = begin
        result.inspect
      rescue StandardError
        result.to_s
      end
      { 'result' => utf8(text)[0, MAX_TEXT], 'stdout' => utf8(out.string)[0, MAX_TEXT] }
    end

    # ------------------------------------------------------------------
    # Menu
    # ------------------------------------------------------------------
    unless file_loaded?(__FILE__)
      menu = UI.menu('Extensions').add_submenu('SU MCP Bridge')
      id_on = menu.add_item('Start server') { start(true) }
      menu.set_validation_proc(id_on) { running? ? MF_GRAYED : MF_ENABLED }
      id_off = menu.add_item('Stop server') { stop }
      menu.set_validation_proc(id_off) { running? ? MF_ENABLED : MF_GRAYED }
      menu.add_item('Status') { UI.messagebox(status_report) }
      menu.add_item('Open log file') { open_log }
      menu.add_item('Change port...') { change_port_dialog }
      file_loaded(__FILE__)
      start
    end
  end
end
