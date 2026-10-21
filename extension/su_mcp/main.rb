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
    VERSION      = '1.3.0'.freeze
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
      quantity_takeoff measure_tags create_box create_shape create_lines insert_component
      transform_entities set_material set_tag create_tags make_group delete_entities select_entities
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

    # Tag folders exist from SketchUp 2021.
    def self.folders_supported?
      ls = model.layers
      ls.respond_to?(:add_folder) && ls.respond_to?(:folders)
    end

    # Top-level tag folder of a category. Reuses a folder named exactly `name`, exactly `code`, or starting with
    # "<code> " (so "FL Floor finishes" and "FL San" are the same category); otherwise creates `name`.
    # nil before SketchUp 2021 or without a name.
    def self.tag_folder(code, name)
      return nil if !folders_supported? || name.nil? || name.to_s.empty?
      want = name.to_s
      c = code.to_s
      f = model.layers.folders.find do |x|
        n = x.name.to_s
        n == want || (!c.empty? && (n == c || n.start_with?("#{c} ")))
      end
      f || model.layers.add_folder(want)
    end

    def self.to_color(c)
      return nil if c.nil? || (c.respond_to?(:empty?) && c.empty?)
      c.is_a?(Array) ? Sketchup::Color.new(*c.first(3).map(&:to_i)) : Sketchup::Color.new(c.to_s)
    end

    # style = {'color' => [r, g, b] or '#RRGGBB', 'folder' => 'FL Floor finishes', 'folder_code' => 'FL'}, all optional.
    # Returns [color_applied, folder_applied].
    def self.style_tag(tag, style)
      return [false, false] unless style.is_a?(Hash)
      color_done = false
      folder_done = false
      col = to_color(style['color'])
      if col && tag.respond_to?(:color=)
        tag.color = col
        color_done = true
      end
      f = tag_folder(style['folder_code'], style['folder'])
      if f
        f.add_layer(tag) unless tag.respond_to?(:folder) && tag.folder == f
        folder_done = true
      end
      [color_done, folder_done]
    end

    # A missing tag is created; `style` (folder/color) is only applied to a tag created here, never to an existing one.
    def self.get_tag(name, style = nil)
      return nil if name.nil? || name.to_s.empty?
      tag = model.layers[name.to_s]
      return tag if tag
      tag = model.layers.add(name.to_s)
      style_tag(tag, style)
      tag
    end

    def self.apply_common(ent, params)
      ent.name = params['name'].to_s if params['name'] && ent.respond_to?(:name=)
      tag = get_tag(params['tag'], params['tag_style'])
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
        h = { 'name' => tag_name(l), 'visible' => l.visible?, 'entity_count' => counts[l],
              'color' => l.color ? l.color.to_a[0, 3] : nil }
        h['folder'] = utf8(l.folder.name) if l.respond_to?(:folder) && l.folder
        h
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
      @qt_ctx = { 'shown' => {} } # tag visibility, including hidden tag folders
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
        next if !include_hidden && (e.hidden? || !layer_shown?(e.layer, @qt_ctx))
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
    # measure_tags: per-tag measurements for an interior bill of quantities. The MCP server picks the unit
    # of each row from its tag standard (FL floor -> plan area, WL wall -> wall area, SK skirting -> length...).
    # Read only. Faces are split into PIECES (faces with the same tag in one group/component that share edges)
    # and each piece is measured in its own frame, taken from its largest face (so a wall drawn at an angle
    # inside a group is measured like a straight one). Per tag:
    #   plan_area  - floors/ceilings: a thin board (also sloped) counts one of its two big sides; any other piece
    #                its non-vertical faces at their real area, halved when it is closed;
    #   sheet_area - THIN pieces (thickness <= thin_ratio x their smaller in-plane size, and <= max_thickness):
    #                area of one side (the smaller side when they differ, so an opening cut in one face only is
    #                deducted); a curved or segmented piece: half its vertical faces;
    #   wall_area  - sheet_area of the thin pieces that stand upright (walls, partitions, glass, cladding);
    #   side_area  - total area of vertical faces;
    #   length     - a straight run: its longest size; a run around a room made with Follow Me: its swept
    #                length. Parallel overlapping parts of one object (a board and its cap) count once;
    #   elevation  - per object: width x height in its own axes (curtains, wardrobe fronts);
    #   count      - objects: outermost group/component carrying the tag, by definition name (items);
    #   volume     - solid objects (inside a non-solid one: its solid parts), with the parents' scaling.
    # Inside an object with a standard tag (code like FL-01), faces and nested objects without a code tag
    # belong to it: only nested objects with their own code tag start another line.
    # Rooms: a NAMED group/component WITHOUT a tag that is not part of an item is a room, e.g. "Living room";
    # a named group that only holds rooms is a level ("Level 2 / Bedroom 1"). A group whose tag has no code but
    # which holds tagged objects (e.g. a "Level 1" tag) is a container too. An object outside any room takes
    # its room from its own name "<code> <room> - <location>". Geometry in no tagged object is reported in
    # 'untagged'. Hidden objects and tags (also hidden tag folders) are skipped unless include_hidden, and
    # reported in 'hidden'.
    # ------------------------------------------------------------------
    FLAT_TOL = 0.5 / 25.4 # 0.5 mm in inches
    RUN_GAP  = 150 / 25.4 # parts of one skirting/cornice run lie within 150 mm of each other

    # "FL-01 Floor" -> ['FL', 'FL-01'];  "LT Lighting" -> ['LT', nil];  "Walls" -> [nil, nil]
    def self.tag_code(name)
      m = name.to_s.strip.match(/\A([A-Za-z]{2,3})(?:[-_ ]?(\d{1,3}))?(?=[\s\-_.:]|\z)/)
      return [nil, nil] unless m
      code = m[1].upcase
      [code, m[2] ? "#{code}-#{m[2].rjust(2, '0')}" : nil]
    end

    # Length of each local axis after the transformation (SketchUp keeps a uniform scale in element 15).
    def self.axis_scales(tr)
      a = tr.to_a
      w = a[15].to_f
      w = 1.0 if w.abs < 1e-12
      [Math.sqrt(a[0]**2 + a[1]**2 + a[2]**2) / w.abs,
       Math.sqrt(a[4]**2 + a[5]**2 + a[6]**2) / w.abs,
       Math.sqrt(a[8]**2 + a[9]**2 + a[10]**2) / w.abs]
    end

    # Volume scale factor of a transformation (determinant of its linear part).
    def self.volume_scale(tr)
      a = tr.to_a
      w = a[15].to_f
      w = 1.0 if w.abs < 1e-12
      det = a[0] * (a[5] * a[10] - a[9] * a[6]) - a[4] * (a[1] * a[10] - a[9] * a[2]) + a[8] * (a[1] * a[6] - a[5] * a[2])
      (det / (w**3)).abs
    end

    def self.dot(a, b)
      a.x * b.x + a.y * b.y + a.z * b.z
    end

    # Unit normal of a face in world coordinates (Newell's method on the transformed outer loop: exact for
    # any scaling or mirroring). pos = cache of transformed vertex positions.
    def self.world_normal(f, tr, pos)
      pts = f.outer_loop.vertices.map { |v| pos[v] ||= v.position.transform(tr) }
      nx = ny = nz = 0.0
      pts.each_with_index do |p, i|
        q = pts[(i + 1) % pts.size]
        nx += (p.y - q.y) * (p.z + q.z)
        ny += (p.z - q.z) * (p.x + q.x)
        nz += (p.x - q.x) * (p.y + q.y)
      end
      v = Geom::Vector3d.new(nx, ny, nz)
      v.length > 0 ? v.normalize : Geom::Vector3d.new(0, 0, 1)
    end

    # Tag shown? Also checks its tag folders (SketchUp 2021+).
    def self.layer_shown?(l, ctx)
      c = ctx['shown']
      return c[l] if c.key?(l)
      ok = l.visible?
      f = ok && l.respond_to?(:folder) ? l.folder : nil
      while ok && f
        ok = false if f.respond_to?(:visible?) && !f.visible?
        f = f.respond_to?(:folder) ? f.folder : nil
      end
      c[l] = ok
    end

    def self.cmd_measure_tags(p)
      ratio = p['thin_ratio'].to_f
      ratio = 0.5 unless ratio > 0 && ratio < 1
      max_t = p['max_thickness_mm'].to_f
      max_t = 600.0 unless max_t > 0
      ctx = { 'hidden' => p['include_hidden'] ? true : false, 'ratio' => ratio, 'max_t' => max_t.mm, 'rows' => {},
              'codes' => {}, 'exclude' => Array(p['exclude_codes']).map { |c| c.to_s.upcase }, 'excluded' => Hash.new(0),
              'untagged' => {}, 'skipped' => {}, 'shown' => {}, 'wrap' => {}, 'holds' => {}, 'pure' => {}, 'runs' => {} }
      sel = p['selection_only'] ? true : false
      roots = sel ? model.selection.to_a : model.entities.to_a
      raise ArgumentError, 'selection_only=true but nothing is selected' if sel && roots.empty?
      tr = IDENTITY
      key = nil
      room = ''
      counted = []
      if sel && model.respond_to?(:active_path) && model.active_path
        # the selection is inside an open group: start from the tag and room of the groups around it
        tr = model.edit_transform
        model.active_path.each do |inst|
          ekey = mt_key(inst, key, ctx)
          nm = utf8(inst.name).strip
          if ekey == 'Untagged'
            room = room.empty? ? nm : "#{room} / #{nm}" unless nm.empty?
          elsif key.nil? && mt_code(ekey, ctx).nil?
            room = room.empty? ? nm : "#{room} / #{nm}" unless nm.empty?
          else
            counted += [ekey] unless counted.include?(ekey)
            key = ekey
          end
        end
      end
      mt_walk(roots, tr, key, counted, ctx, nil, room, nil, false, nil, true)
      mt_finish_runs(ctx)
      # rows are kept per [tag, room]; the per-tag rows add up the rooms
      per_tag = {}
      ctx['rows'].each { |(tag, _room), a| mt_merge(per_tag[tag] ||= mt_new, a) }
      order = lambda { |k| [k == 'Untagged' ? 1 : 0, k] }
      r = { 'tags' => per_tag.keys.sort_by(&order).map { |k| mt_out(per_tag[k]).merge('tag' => k) },
            'untagged' => ctx['untagged'].values, 'hidden' => ctx['skipped'].values, 'excluded' => ctx['excluded'],
            'thin_ratio' => ratio, 'max_thickness_mm' => max_t, 'selection_only' => sel }
      if p['by_room']
        r['rooms'] = ctx['rows'].keys.sort_by { |(t, rm)| [rm, order.call(t)] }.map do |(t, rm)|
          mt_out(ctx['rows'][[t, rm]]).merge('tag' => t, 'room' => rm)
        end
      end
      r
    end

    MT_SUMS = %w[plan sheet wall side length elev volume count not_solid loose_faces].freeze
    MT_LISTS = %w[not_thin not_upright uneven not_straight].freeze

    def self.mt_new
      h = { 'items' => Hash.new(0), 'nested' => Hash.new(0), 'ids' => [] }
      MT_LISTS.each { |k| h[k] = [] }
      MT_SUMS.each { |k| h[k] = 0 }
      %w[plan sheet wall side length elev volume].each { |k| h[k] = 0.0 }
      h
    end

    def self.mt_merge(to, a)
      MT_SUMS.each { |k| to[k] += a[k] }
      a['items'].each { |n, c| to['items'][n] += c }
      a['nested'].each { |n, c| to['nested'][n] += c }
      MT_LISTS.each { |k| to[k] = (to[k] + a[k]).first(10) }
      to['ids'] = (to['ids'] + a['ids']).first(50)
      to
    end

    def self.mt_out(a)
      top = lambda { |h| h.sort_by { |n, c| [-c, n] }.first(30).to_h }
      { 'count' => a['count'], 'items' => top.call(a['items']), 'nested_components' => top.call(a['nested']),
        'plan_area_m2' => a['plan'].round(4), 'sheet_area_m2' => a['sheet'].round(4), 'wall_area_m2' => a['wall'].round(4),
        'side_area_m2' => a['side'].round(4), 'length_m' => a['length'].round(4),
        'elevation_area_m2' => a['elev'].round(4), 'volume_m3' => a['volume'].round(6),
        'not_solid' => a['not_solid'], 'not_thin' => a['not_thin'], 'not_upright' => a['not_upright'],
        'uneven_sides' => a['uneven'], 'not_straight' => a['not_straight'], 'loose_faces' => a['loose_faces'],
        'ids' => a['ids'] }
    end

    def self.mt_acc(ctx, key, room)
      ctx['rows'][[key, room]] ||= mt_new
    end

    # "FL-01 Living room - floor" on tag FL-01 -> "Living room". '' unless the name is "<code> <room> - <location>"
    # with the code of the object's own tag (so "WL-01 wall B" or "TV unit - Living room" give no room).
    def self.mt_room_from_name(name, key, ctx)
      s = name.to_s.strip
      m = s.match(/\A[A-Za-z]{2,3}(?:[-_ ]?\d{1,3})?(?=[\s\-_.:])[\s\-_.:]+(.+)\z/)
      return '' unless m && m[1].include?(' - ')
      code = tag_code(s)[0]
      return '' unless code && code == mt_code(key, ctx)
      m[1].split(' - ').first.to_s.strip
    end

    def self.mt_code(key, ctx)
      (ctx['codes'][key] ||= tag_code(key))[0]
    end

    def self.mt_excluded?(key, ctx)
      return false if ctx['exclude'].empty?
      code = mt_code(key, ctx)
      code && ctx['exclude'].include?(code) ? true : false
    end

    def self.mt_container?(e)
      e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
    end

    def self.mt_visible?(e, ctx)
      ctx['hidden'] || !(e.hidden? || !layer_shown?(e.layer, ctx))
    end

    # Effective tag of an entity: inside an object with a code tag, only a nested code tag counts.
    def self.mt_key(e, key, ctx)
      own = untagged?(e.layer) ? nil : utf8(e.layer.name)
      return key if e.is_a?(Sketchup::Face) && key
      return key if key && (own.nil? || (mt_code(key, ctx) && mt_code(own, ctx).nil?))
      own || key || 'Untagged'
    end

    # Does a definition hold (at any depth, visible) an object with a code tag? (rooms and levels do)
    def self.mt_holds_code?(defn, ctx)
      memo = ctx['holds']
      return memo[defn] if memo.key?(defn)
      memo[defn] = false
      memo[defn] = defn.entities.any? do |x|
        next false unless mt_container?(x) && mt_visible?(x, ctx)
        (!untagged?(x.layer) && mt_code(utf8(x.layer.name), ctx)) || mt_holds_code?(x.definition, ctx)
      end
    end

    # A pure container (a level): no faces and no code-tagged objects of its own, only other groups.
    def self.mt_pure?(defn, ctx)
      memo = ctx['pure']
      return memo[defn] if memo.key?(defn)
      memo[defn] = defn.entities.none? do |x|
        x.is_a?(Sketchup::Face) || (mt_container?(x) && !untagged?(x.layer) && mt_code(utf8(x.layer.name), ctx))
      end
    end

    # Hidden objects are skipped (unless include_hidden) and reported; hidden untagged groups only when they hold
    # tagged objects (a hidden room or level).
    def self.mt_skip(e, ekey, ctx)
      return false if mt_visible?(e, ctx)
      if mt_container?(e) && (ekey != 'Untagged' || mt_holds_code?(e.definition, ctx))
        s = ctx['skipped'][ekey] ||= { 'tag' => ekey, 'objects' => 0, 'hidden_tag' => false, 'names' => [] }
        s['objects'] += 1
        s['hidden_tag'] = true unless layer_shown?(e.layer, ctx)
        if ekey == 'Untagged' && s['names'].size < 10
          nm = utf8(e.name).strip
          s['names'] << { 'id' => e.entityID, 'name' => nm.empty? ? utf8(e.definition.name) : nm }
        end
      end
      true
    end

    # key = tag of the enclosing tagged object (nil outside any); counted = tags already counted by an ancestor;
    # room = room path; culprit = outermost untagged, non-room object we are inside (for the untagged report);
    # need_vol = the enclosing counted object is not solid, so its solid parts give the volume;
    # obj = id of the object counted for key (its runs are merged); pure = the room holds only rooms (a level).
    def self.mt_walk(ents, tr, key, counted, ctx, owner, room, culprit, need_vol, obj, pure)
      buckets = {}
      ents.each do |e|
        next unless e.is_a?(Sketchup::Face) || mt_container?(e) # edges, texts, guides... are not measured
        ekey = mt_key(e, key, ctx)
        if mt_excluded?(ekey, ctx)
          ctx['excluded'][ekey] += 1 if mt_container?(e)
          next
        end
        next if mt_skip(e, ekey, ctx)
        if e.is_a?(Sketchup::Face)
          (buckets[ekey] ||= []) << e
          next
        end
        wt = tr * e.transformation
        nm = utf8(e.name).strip
        defn = e.definition
        if ekey == 'Untagged' || (key.nil? && mt_code(ekey, ctx).nil? && mt_holds_code?(defn, ctx))
          # not a BOQ item: a named one is a room (a level when it only holds rooms), unless it is a part of an
          # untagged assembly; any other one is transparent
          if !nm.empty? && (room.empty? || pure) && (culprit.nil? || mt_holds_code?(defn, ctx))
            mt_walk(defn.entities, wt, nil, counted, ctx, e, room.empty? ? nm : "#{room} / #{nm}", nil, false, nil,
                    mt_pure?(defn, ctx))
          else
            mt_walk(defn.entities, wt, nil, counted, ctx, e, room, ekey == 'Untagged' ? (culprit || e) : culprit,
                    false, nil, false)
          end
          next
        end
        # an untagged door/window (cuts an opening) inside a wall is not part of the wall finish
        if key && ekey == key && e.is_a?(Sketchup::ComponentInstance) && defn.behavior.cuts_opening?
          mt_acc(ctx, ekey, room)['nested']["(opening) #{utf8(defn.name)}"] += 1
          next
        end
        first = !counted.include?(ekey)
        # a group of objects that carry this tag themselves (6 FN-01 chairs grouped, the group tagged FN-01 too)
        # is only a container: its objects are counted
        if first && mt_wrapper?(defn, ekey, ctx)
          mt_walk(defn.entities, wt, ekey, counted, ctx, e, room, culprit, false, nil, false)
          next
        end
        eroom = room
        eobj = obj
        if first
          eroom = mt_room_from_name(nm, ekey, ctx) if room.empty?
          mt_object(e, wt, ekey, ctx, eroom)
          eobj = e.entityID
        elsif e.is_a?(Sketchup::ComponentInstance)
          mt_acc(ctx, ekey, eroom)['nested'][utf8(defn.name)] += 1
        end
        child_vol = first || need_vol ? !mt_volume(e, tr, ekey, ctx, eroom) : false
        # geometry of its own that is not a solid: its volume is missing
        mt_acc(ctx, ekey, eroom)['not_solid'] += 1 if child_vol && defn.entities.any? { |x| x.is_a?(Sketchup::Face) }
        mt_walk(defn.entities, wt, ekey, first ? counted + [ekey] : counted, ctx, e, eroom, culprit, child_vol, eobj, false)
      end
      buckets.each do |k, faces|
        if k == 'Untagged'
          mt_untagged(faces, ctx, culprit || owner, room)
          next
        end
        mt_pieces(faces).each { |pc| mt_piece(pc, tr, k, k != key, ctx, owner, room, k == key ? obj : nil) }
      end
    end

    # Does a definition hold (at any depth) a visible group/component that carries `key` itself?
    def self.mt_wrapper?(defn, key, ctx)
      memo = ctx['wrap']
      mk = [defn, key]
      return memo[mk] if memo.key?(mk)
      memo[mk] = false # also stops a recursive definition
      memo[mk] = defn.entities.any? do |x|
        next false unless mt_container?(x) && mt_visible?(x, ctx)
        (!untagged?(x.layer) && utf8(x.layer.name) == key) || mt_wrapper?(x.definition, key, ctx)
      end
    end

    # Adds the volume of a solid object (with its parents' scaling); false when it is not solid.
    def self.mt_volume(e, tr, key, ctx, room)
      v = e.volume
      return false unless v && v > 0
      mt_acc(ctx, key, room)['volume'] += v * volume_scale(tr) * IN3_TO_M3
      true
    end

    # Pieces of a list of faces: faces that share an edge, following only faces of the list (not other tags).
    def self.mt_pieces(faces)
      return [faces] if faces.size == 1
      inb = {}
      faces.each { |f| inb[f] = true }
      seen = {}
      out = []
      faces.each do |f|
        next if seen[f]
        seen[f] = true
        pc = [f]
        i = 0
        while i < pc.size
          pc[i].edges.each do |ed|
            ed.faces.each do |g|
              next if seen[g] || !inb[g]
              seen[g] = true
              pc << g
            end
          end
          i += 1
        end
        out << pc
      end
      out
    end

    # Geometry in no tagged object, reported per outermost untagged object (or the room / top level holding it).
    def self.mt_untagged(faces, ctx, holder, room)
      id = holder ? holder.entityID : 0
      u = ctx['untagged'][id]
      if u.nil?
        return if ctx['untagged'].size >= 50
        name = if holder.nil?
                 '(top level)'
               elsif holder.is_a?(Sketchup::ComponentInstance) && holder.name.to_s.empty?
                 utf8(holder.definition.name)
               else
                 utf8(holder.name)
               end
        u = ctx['untagged'][id] = { 'id' => holder ? id : nil, 'name' => name, 'room' => room, 'faces' => 0 }
      end
      u['faces'] += faces.size
    end

    def self.mt_object(e, wt, key, ctx, room)
      a = mt_acc(ctx, key, room)
      a['count'] += 1
      name = if e.is_a?(Sketchup::Group)
               e.name.to_s.empty? ? '[Group]' : "[Group] #{utf8(e.name)}"
             else
               utf8(e.definition.name)
             end
      a['items'][name] += 1
      a['ids'] << e.entityID if a['ids'].size < 50
      # Width x height in the object's own axes; the height axis is the local axis that stands most upright
      # (a rotated curtain, or one drawn flat and stood up, keeps its real size).
      bb = e.definition.bounds
      return if bb.empty?
      m = wt.to_a
      cols = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]]
      sizes = []
      up = []
      sc = axis_scales(wt)
      [bb.width, bb.height, bb.depth].each_with_index do |ext, i|
        sizes << ext * sc[i]
        len = Math.sqrt(cols[i][0]**2 + cols[i][1]**2 + cols[i][2]**2)
        up << (len > 0 ? cols[i][2].abs / len : 0.0)
      end
      hax = (0..2).max_by { |i| up[i] }
      width = (0..2).reject { |i| i == hax }.map { |i| sizes[i] }.max
      a['elev'] += width * sizes[hax] * IN2_TO_M2
    end

    # One piece: faces with the same tag in one container that share edges. standalone = the faces carry their
    # own tag (outside any tagged object), so they also add width x height and count as loose faces.
    # obj = the counted object holding the piece: its straight runs are merged at the end (mt_finish_runs).
    def self.mt_piece(faces, tr, key, standalone, ctx, owner, room, obj)
      a = mt_acc(ctx, key, room)
      pos = {}
      areas = faces.map { |f| f.area(tr) * IN2_TO_M2 }
      normals = faces.map { |f| world_normal(f, tr, pos) }
      faces.each { |f| f.vertices.each { |vx| pos[vx] ||= vx.position.transform(tr) } }
      big = (0...faces.size).max_by { |i| areas[i] }
      n = normals[big]
      if n.z.abs < 0.98
        u = n.cross(Geom::Vector3d.new(0, 0, 1)).normalize
      else
        # (near) horizontal: along its longest edge, kept in the face plane
        ed = faces[big].edges.max_by { |x| x.length }
        d = (pos[ed.end] ||= ed.end.position.transform(tr)) - (pos[ed.start] ||= ed.start.position.transform(tr))
        k = dot(d, n)
        d = Geom::Vector3d.new(d.x - n.x * k, d.y - n.y * k, d.z - n.z * k)
        u = d.length > 0 ? d.normalize : Geom::Vector3d.new(1, 0, 0)
      end
      v = n.cross(u).normalize
      nx = n.x; ny = n.y; nz = n.z; ux = u.x; uy = u.y; uz = u.z; vx_ = v.x; vy = v.y; vz = v.z
      lo0 = lo1 = lo2 = zmin = nil
      hi0 = hi1 = hi2 = zmax = nil
      pos.each_value do |q|
        s0 = q.x * nx + q.y * ny + q.z * nz
        s1 = q.x * ux + q.y * uy + q.z * uz
        s2 = q.x * vx_ + q.y * vy + q.z * vz
        lo0 = s0 if lo0.nil? || s0 < lo0
        hi0 = s0 if hi0.nil? || s0 > hi0
        lo1 = s1 if lo1.nil? || s1 < lo1
        hi1 = s1 if hi1.nil? || s1 > hi1
        lo2 = s2 if lo2.nil? || s2 < lo2
        hi2 = s2 if hi2.nil? || s2 > hi2
        zmin = q.z if zmin.nil? || q.z < zmin
        zmax = q.z if zmax.nil? || q.z > zmax
      end
      t = hi0 - lo0
      su = hi1 - lo1
      sv = hi2 - lo2
      flat = t < FLAT_TOL
      thin = flat || (t <= ctx['ratio'] * [su, sv].min && t <= ctx['max_t'])
      upright = n.z.abs < 0.17
      # closed piece: every edge is shared by two of its faces (a board, a wall solid)
      uses = Hash.new(0)
      faces.each { |f| f.edges.each { |e2| uses[e2] += 1 } }
      closed = !uses.empty? && uses.values.all? { |c| c >= 2 }
      nonvert = side = horiz = 0.0
      curved = false
      par = []
      faces.each_with_index do |f, i|
        ar = areas[i]
        w = normals[i]
        c = dot(w, n)
        if w.z.abs >= 0.17
          nonvert += ar
        else
          side += ar
          curved = true if c.abs > 0.17 && c.abs < 0.99
        end
        horiz += ar * Math.sqrt(w.x * w.x + w.y * w.y)
        par << [ar, c, dot(pos[f.vertices.first], n)] if c.abs > 0.99
      end
      # the two sides of the piece: by the direction of the face normals (a pilaster or a niche on one side
      # stays on its side); faces all turned the same way (reversed faces): by their position
      side_a = side_b = 0.0
      if par.any? { |x| x[1] > 0 } && par.any? { |x| x[1] < 0 }
        par.each { |ar, c, _| c > 0 ? side_a += ar : side_b += ar }
      else
        mid = (lo0 + hi0) / 2.0
        par.each { |ar, _, off| flat || off < mid ? side_a += ar : side_b += ar }
      end
      one = flat || side_a.zero? || side_b.zero? ? side_a + side_b : [side_a, side_b].min
      label = lambda do
        { 'id' => owner ? owner.entityID : nil, 'name' => owner ? utf8(owner.name) : '(faces at the top level)',
          'size_mm' => [su, sv, t].map { |d| to_mm(d).round } }
      end
      if thin && !upright && !curved && side_a + side_b >= 0.9 * nonvert
        a['plan'] += one
      else
        a['plan'] += closed ? nonvert / 2.0 : nonvert
      end
      a['side'] += side
      # length: a straight run its longest size; a run that turns (Follow Me around a room) its swept length,
      # i.e. the horizontal part of its face areas / (2 x its height)
      h = zmax - zmin
      dims = [t, su, sv]
      li = (0..2).max_by { |i| dims[i] }
      len = dims[li]
      swept = h > FLAT_TOL ? horiz / IN2_TO_M2 / (2 * h) : 0.0
      straight = !(swept > 1.1 * len) || (thin && upright && !curved)
      len = swept unless straight
      if obj && straight
        ax = [n, u, v][li]
        lo = [lo0, lo1, lo2][li]
        hi = [hi0, hi1, hi2][li]
        c0 = Geom::Point3d.new((pos.values.map(&:x).min + pos.values.map(&:x).max) / 2.0,
                               (pos.values.map(&:y).min + pos.values.map(&:y).max) / 2.0, (zmin + zmax) / 2.0)
        (ctx['runs'][[key, room, obj]] ||= []) << [ax, lo, hi, c0, len]
      else
        a['length'] += len * IN_TO_MM / 1000.0
      end
      if thin
        if upright && curved
          one = side / 2.0
          a['not_straight'] << label.call if a['not_straight'].size < 10
        end
        a['sheet'] += one
        if upright
          a['wall'] += one
        elsif a['not_upright'].size < 10
          a['not_upright'] << label.call
        end
        if !curved && !flat && side_a > 0 && side_b > 0 && (side_a - side_b).abs > 0.02 * [side_a, side_b].max &&
           a['uneven'].size < 10
          a['uneven'] << label.call.merge('sides_m2' => [side_a.round(2), side_b.round(2)])
        end
      elsif a['not_thin'].size < 10
        a['not_thin'] << label.call
      end
      return unless standalone
      a['loose_faces'] += faces.size
      a['elev'] += upright ? su * sv * IN2_TO_M2 : 0.0
    end

    # Straight runs of one object: parallel parts that overlap along their length and lie within RUN_GAP of each
    # other (a skirting board and its cap) count once, the longest; separate runs are added up.
    def self.mt_finish_runs(ctx)
      ctx['runs'].each do |(key, room, _obj), runs|
        kept = []
        runs.sort_by { |r| -r[4] }.each do |r|
          ax, lo, hi, c0, len = r
          dup = kept.any? do |k|
            kax, klo, khi, kc = k
            cs = dot(ax, kax)
            next false unless cs.abs > 0.99
            # r's interval on k's axis
            a1 = lo * cs
            b1 = hi * cs
            rlo = [a1, b1].min
            rhi = [a1, b1].max
            over = [rhi, khi].min - [rlo, klo].max
            next false unless over > 0.5 * [hi - lo, khi - klo].min
            d = c0 - kc
            along = dot(d, kax)
            perp = Math.sqrt([d.x * d.x + d.y * d.y + d.z * d.z - along * along, 0.0].max)
            perp < RUN_GAP
          end
          kept << r unless dup
        end
        mt_acc(ctx, key, room)['length'] += kept.inject(0.0) { |s, r| s + r[4] } * IN_TO_MM / 1000.0
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

    # Create several tags in one Undo step, each with an optional folder (SketchUp 2021+) and color.
    # tags = [{'name' => 'FL-01 ...', 'color' => [r, g, b], 'folder' => 'FL Floor finishes', 'folder_code' => 'FL'}, ...]
    # An existing tag keeps its folder and color unless update_existing is true.
    def self.cmd_create_tags(p)
      list = Array(p['tags'])
      raise ArgumentError, 'tags must be a non-empty list' if list.empty?
      update = p['update_existing'] ? true : false
      with_operation('create_tags') do |m|
        out = list.map do |t|
          t = { 'name' => t } unless t.is_a?(Hash)
          name = t['name'].to_s.strip
          raise ArgumentError, 'Every tag needs a name' if name.empty?
          tag = m.layers[name]
          created = tag.nil?
          tag ||= m.layers.add(name)
          color_done, folder_done = created || update ? style_tag(tag, t) : [false, false]
          h = { 'name' => utf8(tag.name), 'created' => created, 'color_applied' => color_done, 'folder_applied' => folder_done }
          h['folder'] = utf8(tag.folder.name) if tag.respond_to?(:folder) && tag.folder
          h
        end
        r = { 'tags' => out, 'created' => out.count { |h| h['created'] }, 'folders_supported' => folders_supported? }
        r['note'] = 'Tag folders need SketchUp 2021 or later: the tags were created without folders.' unless folders_supported?
        r
      end
    end

    # Put existing entities into a new group, e.g. a room ("Living room", no tag) holding its finishes and items.
    # The entities must be in the context being edited (model.active_entities): SketchUp's add_group is only
    # reliable there. One Undo step.
    def self.cmd_make_group(p)
      raise ArgumentError, 'entity_ids are required' if Array(p['entity_ids']).empty?
      ents = find_entities(p)
      act = model.active_entities
      ents.each do |e|
        next if e.parent == act.parent
        raise ArgumentError, "Entity #{e.entityID} is not in the context being edited (it is inside another group/component); " \
                             'close the group being edited or pick entities at the same level'
      end
      with_operation('make_group') do |_m|
        g = act.add_group(ents.uniq)
        g.name = p['name'].to_s if p['name'] && !p['name'].to_s.empty?
        # no tag given: Untagged (a room), never the tag that happens to be active in SketchUp
        g.layer = get_tag(p['tag'], p['tag_style']) || model.layers[0]
        entity_summary(g).merge('grouped' => ents.uniq.size)
      end
    end

    def self.cmd_set_tag(p)
      ents = find_entities(p)
      with_operation('set_tag') do |_m|
        tag = get_tag(p['tag'], p['tag_style'])
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
