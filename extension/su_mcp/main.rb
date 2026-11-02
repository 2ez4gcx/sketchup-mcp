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
    VERSION      = '1.4.0'.freeze
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
      create_room check_model create_scenes check_design
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
                    false, nil, nm.empty? ? pure : false) # an unnamed group inside a level is transparent
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
    # create_room: a finished room from its outline (the bare inner face of its walls). Every finish is its own tagged
    # group inside one untagged room group named after the room, so interior_takeoff measures it right away:
    #   floor finish  - top at the finished floor level (FFL), thickness below it;
    #   wall finishes - one thin panel per outline edge, built inward, openings cut through; each panel group is
    #                   placed in its edge's own axes (x along the edge, y into the room), so its box follows the wall;
    #   ceiling board - underside at FFL + height;
    #   skirting      - one run per edge inside the wall finish, interrupted at doors, stopping at the wall finish of
    #                   the next wall at convex corners;
    #   doors/windows - a leaf/pane in each opening that has a tag (DR/WN: counted as items).
    # Lengths in mm. One Undo step.
    # ------------------------------------------------------------------
    ROOM_WORDS = {
      'en' => { 'floor' => 'floor', 'ceiling' => 'ceiling', 'wall' => 'wall', 'skirting' => 'skirting',
                'door' => 'door', 'window' => 'window' },
      'vi' => { 'floor' => "sàn", 'ceiling' => "trần", 'wall' => "tường", 'skirting' => 'len',
                'door' => "cửa", 'window' => "cửa sổ" }
    }.freeze

    def self.num(v, name)
      Float(v)
    rescue StandardError
      raise ArgumentError, "#{name} must be a number (mm), got: #{v.inspect}"
    end

    # "<code> <room> - <location>", e.g. "WL-01 Living room - wall 2"; without a tag: "<room> - <location>".
    def self.room_part_name(tag, room, location)
      code = tag ? (tag_code(tag)[1] || tag_code(tag)[0]) : nil
      [code, "#{room} - #{location}"].compact.join(' ')
    end

    def self.room_finish(g, cfg, name, styles)
      g.name = name
      tag = cfg['tag'].to_s.empty? ? nil : get_tag(cfg['tag'], styles[cfg['tag'].to_s])
      g.layer = tag || model.layers[0]
      mat = get_material(cfg['material'], cfg['color'])
      g.material = mat if mat
      g
    end

    # Group placed in the axes of an outline edge: x along the edge from point a, y into the room, z up from FFL.
    def self.room_edge_group(ents, a, b, ffl)
      dx = b[0] - a[0]
      dy = b[1] - a[1]
      len = Math.sqrt(dx * dx + dy * dy)
      u = Geom::Vector3d.new(dx / len, dy / len, 0)
      n = Geom::Vector3d.new(-dy / len, dx / len, 0) # counter-clockwise outline: the room is on the left
      g = ents.add_group
      g.transformation = Geom::Transformation.axes(Geom::Point3d.new(a[0].mm, a[1].mm, ffl), u, n, Z_AXIS)
      g
    end

    # A box in edge axes: s0..s1 along the edge, z0..z1 up, off..off + t into the room (mm); holes cut through it.
    # Returns false when nothing is left (an opening covers the whole panel).
    def self.room_panel(ents, s0, s1, z0, z1, off, t, holes = [])
      pt = lambda { |s, z| Geom::Point3d.new(s.mm, off.mm, z.mm) }
      ents.add_face(pt.call(s0, z0), pt.call(s1, z0), pt.call(s1, z1), pt.call(s0, z1))
      holes.each do |h0, h1, hz0, hz1|
        hole = ents.add_face(pt.call(h0, hz0), pt.call(h1, hz0), pt.call(h1, hz1), pt.call(h0, hz1))
        hole.erase! if hole && hole.valid?
      end
      ents.grep(Sketchup::Edge).select { |e| e.faces.empty? }.each { |e| e.erase! if e.valid? }
      faces = ents.grep(Sketchup::Face).to_a
      return false if faces.empty?
      # an opening running full height or full width splits the panel: push every piece
      faces.each do |face|
        next unless face.valid?
        face.reverse! if face.normal.y < 0
        face.pushpull(t.mm)
      end
      true
    end

    def self.seg_cross?(p1, p2, q1, q2)
      d = lambda { |a, b, c| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) }
      d1 = d.call(q1, q2, p1)
      d2 = d.call(q1, q2, p2)
      d3 = d.call(p1, p2, q1)
      d4 = d.call(p1, p2, q2)
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    end

    def self.cmd_create_room(p)
      name = p['name'].to_s.strip
      raise ArgumentError, 'name (the room name) is required' if name.empty?
      level = num(p['level'] || 0, 'level')
      height = num(p['height'] || 2700, 'height')
      raise ArgumentError, 'height must be > 0 (mm)' unless height > 0
      pts = Array(p['points']).map do |q|
        raise ArgumentError, "Every outline point must be [x, y] (mm), got: #{q.inspect}" unless q.is_a?(Array) && q.size >= 2
        [num(q[0], 'x'), num(q[1], 'y')]
      end
      pts.pop if pts.size > 3 && (pts.last[0] - pts.first[0]).abs < 0.5 && (pts.last[1] - pts.first[1]).abs < 0.5
      raise ArgumentError, 'The outline needs at least 3 points' if pts.size < 3
      pts.each_with_index do |q, i|
        r = pts[(i + 1) % pts.size]
        next unless (r[0] - q[0]).abs < 0.5 && (r[1] - q[1]).abs < 0.5
        raise ArgumentError, "Points #{i + 1} and #{(i + 1) % pts.size + 1} are the same: remove one (edges are numbered from the points)"
      end
      n = pts.size
      n.times do |i|
        (i + 2...n).each do |j|
          next if i.zero? && j == n - 1
          if seg_cross?(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])
            raise ArgumentError, "The outline crosses itself (edge #{i + 1} and edge #{j + 1}): list the points in order around the room"
          end
        end
      end
      area2 = 0.0
      pts.each_with_index { |q, i| r = pts[(i + 1) % n]; area2 += q[0] * r[1] - r[0] * q[1] }
      raise ArgumentError, 'The outline has no area (points in a line?)' if area2.abs < 1.0
      reversed = area2 < 0
      pts.reverse! if reversed # counter-clockwise from here on
      lens = (0...n).map { |i| a = pts[i]; b = pts[(i + 1) % n]; Math.sqrt((b[0] - a[0])**2 + (b[1] - a[1])**2) }
      given = lambda { |i| (reversed ? (n - 2 - i) % n : i) + 1 } # edge number as the user gave it
      words = ROOM_WORDS[p['language'] == 'vi' ? 'vi' : 'en'].merge(p['labels'].is_a?(Hash) ? p['labels'].reject { |_, v| v.to_s.empty? } : {})
      styles = p['tag_styles'].is_a?(Hash) ? p['tag_styles'] : {}
      floor = p['floor'].is_a?(Hash) ? p['floor'] : nil
      walls = p['walls'].is_a?(Hash) ? p['walls'] : nil
      ceiling = p['ceiling'].is_a?(Hash) ? p['ceiling'] : nil
      skirting = p['skirting'].is_a?(Hash) ? p['skirting'] : nil
      wall_h = walls && walls['height'] ? num(walls['height'], 'walls.height') : height
      wall_t = walls ? num(walls['thickness'] || 10, 'walls.thickness') : 0.0
      by_edge = walls && walls['by_edge'].is_a?(Hash) ? walls['by_edge'] : {}
      edge_of = lambda do |k|
        i = Integer(k) - 1
        raise ArgumentError, "Edge #{k} does not exist (the outline has #{n} edges, numbered from 1)" unless i >= 0 && i < n
        reversed ? (n - 2 - i) % n : i
      end
      edge_cfg = {}
      by_edge.each { |k, v| edge_cfg[edge_of.call(k)] = v.is_a?(Hash) ? v : {} }
      opens = Array(p['openings']).map do |o|
        raise ArgumentError, 'Every opening must be an object' unless o.is_a?(Hash)
        e = edge_of.call(o['edge'])
        w = num(o['width'], 'opening width')
        h = num(o['height'], 'opening height')
        sill = num(o['sill'] || 0, 'opening sill')
        off = num(o['offset'] || 0, 'opening offset')
        off = lens[e] - off - w if reversed # offsets are measured from the start of the edge as given
        raise ArgumentError, "Opening on edge #{o['edge']}: width and height must be > 0" unless w > 0 && h > 0
        unless off >= -0.5 && off + w <= lens[e] + 0.5
          raise ArgumentError, "Opening on edge #{o['edge']} does not fit: the edge is #{lens[e].round} mm long"
        end
        raise ArgumentError, "Opening on edge #{o['edge']} is higher than the room (#{height.round} mm)" if sill + h > height + 0.5
        code = tag_code(o['tag'].to_s)[0]
        door = code == 'DR' || (code != 'WN' && sill < 50.0) # a door may have a threshold; the tag code decides first
        { 'edge' => e, 'from' => [off, 0.0].max, 'to' => [off + w, lens[e]].min, 'sill' => [sill, 0.0].max,
          'top' => [sill + h, height].min, 'door' => door, 'tag' => o['tag'].to_s, 'material' => o['material'],
          'color' => o['color'], 'name' => o['name'], 'given' => o['edge'] }
      end
      opens.group_by { |o| o['edge'] }.each_value do |list|
        list.sort_by { |o| o['from'] }.each_cons(2) do |x, y|
          next unless y['from'] < x['to'] - 0.5 && y['sill'] < x['top'] && x['sill'] < y['top']
          raise ArgumentError, "Two openings overlap on edge #{x['given']}"
        end
      end
      # At the corner at the END of edge i (point i+1), the finish faces of the two walls meet this far from the corner
      # along the edges: inside the edge at a convex corner (+, wall_t at a right angle), beyond it at a reflex one (-).
      corner = (0...n).map do |i|
        a = pts[i]
        b = pts[(i + 1) % n]
        c = pts[(i + 2) % n]
        ux = b[0] - a[0]
        uy = b[1] - a[1]
        vx = c[0] - b[0]
        vy = c[1] - b[1]
        e = wall_t * Math.tan(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) / 2.0)
        lim = [lens[i], lens[(i + 1) % n]].min / 2.0 # very sharp corners
        e > lim ? lim : (e < -lim ? -lim : e)
      end
      ffl = level.mm
      parts = []
      q = { 'floor_area_m2' => (area2.abs / 2.0 / 1e6).round(3), 'perimeter_m' => (lens.inject(:+) / 1000.0).round(3) }
      with_operation('create_room') do |m|
        old_layer = m.active_layer
        m.active_layer = m.layers[0] # raw faces and edges stay Untagged, whatever tag is active
        begin
          room = m.active_entities.add_group
          room.name = name
          room.layer = m.layers[0]
          ents = room.entities
          add = lambda { |g, kind| parts << { 'id' => g.entityID, 'kind' => kind, 'name' => utf8(g.name), 'tag' => tag_name(g.layer) } }
          if floor
            g = ents.add_group
            f = g.entities.add_face(pts.map { |x, y| Geom::Point3d.new(x.mm, y.mm, ffl) })
            f.reverse! if f.normal.z < 0
            f.pushpull(-num(floor['thickness'] || 12, 'floor.thickness').mm)
            add.call(room_finish(g, floor, room_part_name(floor['tag'], name, words['floor']), styles), 'floor')
          end
          if ceiling
            g = ents.add_group
            f = g.entities.add_face(pts.map { |x, y| Geom::Point3d.new(x.mm, y.mm, ffl + height.mm) })
            f.reverse! if f.normal.z < 0
            f.pushpull(num(ceiling['thickness'] || 9, 'ceiling.thickness').mm)
            add.call(room_finish(g, ceiling, room_part_name(ceiling['tag'], name, words['ceiling']), styles), 'ceiling')
            q['ceiling_area_m2'] = q['floor_area_m2']
          end
          skip = lambda { |i| edge_cfg[i] && edge_cfg[i]['none'] }
          if walls
            gross = net = 0.0
            n.times do |i|
              next if skip.call(i)
              cfg = walls.merge((edge_cfg[i] || {}).reject { |k, v| k == 'none' || v.nil? || v.to_s.empty? })
              # holes clipped to the wall height (a wainscot lower than a door top is simply cut)
              holes = opens.select { |o| o['edge'] == i && o['sill'] < wall_h - 0.5 }.map { |o| [o['from'], o['to'], o['sill'], [o['top'], wall_h].min] }
              g = room_edge_group(ents, pts[i], pts[(i + 1) % n], ffl)
              # at a reflex corner the panel runs on to the next wall's finish face (no notch between the two finishes)
              ext = corner[i] < 0 && !skip.call((i + 1) % n) ? -corner[i] : 0.0
              if room_panel(g.entities, 0.0, lens[i] + ext, 0.0, wall_h, 0.0, wall_t, holes)
                add.call(room_finish(g, cfg, room_part_name(cfg['tag'], name, "#{words['wall']} #{given.call(i)}"), styles), 'wall')
              else
                g.erase!
              end
              gross += lens[i] * wall_h
              net += lens[i] * wall_h - holes.inject(0.0) { |s, h| s + (h[1] - h[0]) * (h[3] - h[2]) }
            end
            q['wall_area_gross_m2'] = (gross / 1e6).round(3)
            q['wall_area_net_m2'] = (net / 1e6).round(3)
          end
          if skirting
            sh = num(skirting['height'] || 80, 'skirting.height')
            st = num(skirting['thickness'] || 12, 'skirting.thickness')
            total = 0.0
            n.times do |i|
              next if skip.call(i)
              # on the wall finish face, from one neighbouring finish face to the other (shorter than the edge at
              # convex corners, longer at reflex ones)
              start = skip.call((i - 1) % n) ? 0.0 : corner[(i - 1) % n]
              stop = skip.call((i + 1) % n) ? lens[i] : lens[i] - corner[i]
              cuts = opens.select { |o| o['edge'] == i && o['sill'] < sh }.map { |o| [o['from'], o['to']] }.sort # doors, floor windows
              segs = []
              s = start
              cuts.each do |c0, c1|
                segs << [s, [c0, stop].min] if [c0, stop].min - s > 1.0
                s = [s, c1].max
              end
              segs << [s, stop] if stop - s > 1.0
              next if segs.empty?
              g = room_edge_group(ents, pts[i], pts[(i + 1) % n], ffl)
              segs.each do |s0, s1|
                sub = g.entities.add_group
                room_panel(sub.entities, s0, s1, 0.0, sh, wall_t, st)
                sub.explode
                total += s1 - s0
              end
              add.call(room_finish(g, skirting, room_part_name(skirting['tag'], name, "#{words['skirting']} #{given.call(i)}"), styles), 'skirting')
            end
            q['skirting_m'] = (total / 1000.0).round(3)
          end
          opens.each_with_index do |o, k|
            next if o['tag'].empty?
            i = o['edge']
            g = room_edge_group(ents, pts[i], pts[(i + 1) % n], ffl)
            th = o['door'] ? 40.0 : 10.0 # door leaf / glass pane, centred in the wall finish
            room_panel(g.entities, o['from'], o['to'], o['sill'], o['top'], wall_t / 2.0 - th / 2.0, th)
            label = o['name'].to_s.empty? ? "#{o['door'] ? words['door'] : words['window']} #{k + 1}" : o['name'].to_s
            add.call(room_finish(g, o, room_part_name(o['tag'], name, label), styles), o['door'] ? 'door' : 'window')
          end
          { 'room' => entity_summary(room), 'parts' => parts, 'quantities' => q,
            'note' => 'Edges are numbered from 1 (edge 1 goes from point 1 to point 2). The floor finish lies below the ' \
                      'finished floor level, the ceiling board above FFL + height; walls and skirting are inside the outline.' }
        ensure
          m.active_layer = old_layer if old_layer && old_layer.valid?
        end
      end
    end

    # ------------------------------------------------------------------
    # check_model: model health check (read only, unless purge). Every entity collection is checked once.
    # ------------------------------------------------------------------
    UNIT_NAMES = %w[inch feet mm cm m yard].freeze

    def self.ck_holder(e)
      return { 'id' => nil, 'name' => '(top level)' } if e.nil?
      nm = utf8(e.name).strip
      nm = utf8(e.definition.name) if nm.empty? && e.is_a?(Sketchup::ComponentInstance)
      { 'id' => e.entityID, 'name' => nm.empty? ? '[Group]' : nm }
    end

    def self.ck_add(st, key, item, cap = 20)
      list = st[key] ||= []
      list << item if list.size < cap
    end

    # Checks of one entity collection (a definition's or the model's), done once whatever its instance count.
    def self.ck_collection(ents, owner, st)
      faces = edges = stray = tiny = raw_tagged = mixed = 0
      seen = {}
      ents.each do |e|
        st['used_layers'][e.layer] = true if e.respond_to?(:layer)
        st['hidden'] += 1 if e.respond_to?(:hidden?) && e.hidden? && (e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance))
        case e
        when Sketchup::Face
          faces += 1
          raw_tagged += 1 unless untagged?(e.layer)
          st['used_mats'][e.material] = true if e.material
          st['used_mats'][e.back_material] = true if e.back_material
        when Sketchup::Edge
          edges += 1
          raw_tagged += 1 unless untagged?(e.layer)
          stray += 1 if e.faces.empty?
          st['used_mats'][e.material] = true if e.material
          fs = e.faces
          mixed += 1 if fs.size == 2 && e.reversed_in?(fs[0]) == e.reversed_in?(fs[1])
          tiny += 1 if e.length < 1.mm
        when Sketchup::Group, Sketchup::ComponentInstance
          st['used_mats'][e.material] = true if e.material
          next if e.hidden? # hidden alternatives of a dynamic component are not duplicates
          a = e.transformation.to_a.map { |v| v.round(4) }
          k = [e.definition, a, e.layer]
          if seen[k]
            ck_add(st, 'dups', { 'id' => e.entityID, 'same_as' => seen[k], 'name' => ck_holder(e)['name'], 'in' => ck_holder(owner)['name'] })
            st['dups_n'] += 1
          else
            seen[k] = e.entityID
          end
        end
      end
      st['faces'] += faces
      st['edges'] += edges
      st['stray'] += stray
      st['tiny'] += tiny
      if stray > 0
        ck_add(st, 'stray_in', ck_holder(owner).merge('edges' => stray))
      end
      if mixed > 0
        st['mixed'] += mixed
        ck_add(st, 'mixed_in', ck_holder(owner).merge('edges' => mixed))
      end
      if raw_tagged > 0
        st['raw_tagged'] += raw_tagged
        ck_add(st, 'raw_tagged_in', ck_holder(owner).merge('count' => raw_tagged))
      end
      faces
    end

    # Signed volume (in3) of a closed definition from its faces: negative when its faces point inwards.
    def self.ck_signed_volume(defn)
      v = 0.0
      defn.entities.grep(Sketchup::Face).each do |f|
        p0 = f.vertices.first.position
        n = f.normal
        v += (p0.x * n.x + p0.y * n.y + p0.z * n.z) * f.area / 3.0
      end
      v
    end

    def self.ck_walk(ents, owner, depth, inside_tagged, st)
      st['depth'] = depth if depth > st['depth']
      dk = owner ? owner.definition : :model
      k = [dk, inside_tagged]
      return if st['visited'][k]
      st['visited'][k] = true
      first = !st['collections'][dk]
      st['collections'][dk] = true
      faces = first ? ck_collection(ents, owner, st) : ents.count { |x| x.is_a?(Sketchup::Face) }
      if faces > 0 && !inside_tagged
        if owner.nil?
          st['raw_top'] = faces
        else
          ck_add(st, 'untagged_in', ck_holder(owner).merge('faces' => faces))
          st['untagged_n'] += 1
        end
      end
      ents.each do |e|
        next unless e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
        d = e.definition
        unless st['solid_checked'].key?(d)
          st['solid_checked'][d] = true
          if e.respond_to?(:manifold?) && e.manifold? && ck_signed_volume(d) < 0
            ck_add(st, 'inside_out', ck_holder(e).merge('definition' => utf8(d.name)))
            st['inside_out_n'] += 1
          end
        end
        ck_walk(d.entities, e, depth + 1, inside_tagged || !untagged?(e.layer), st)
      end
    end

    def self.cmd_check_model(p)
      m = model
      return ck_purge(p) if p['purge_only']
      st = { 'visited' => {}, 'collections' => {}, 'solid_checked' => {}, 'used_layers' => {}, 'used_mats' => {},
             'faces' => 0, 'edges' => 0, 'stray' => 0, 'tiny' => 0, 'raw_tagged' => 0, 'raw_top' => 0, 'hidden' => 0,
             'depth' => 0, 'dups_n' => 0, 'untagged_n' => 0, 'inside_out_n' => 0, 'mixed' => 0 }
      ck_walk(m.entities, nil, 0, false, st)
      st['used_layers'][m.layers[0]] = true
      defs = m.definitions.reject(&:image?)
      used_n = {}
      defs.each { |d| used_n[d] = d.count_used_instances }
      unused_defs = defs.select { |d| used_n[d].zero? }
      # materials owned by images or tags are not the user's materials
      managed = lambda { |x| !x.respond_to?(:owner_type) || !defined?(Sketchup::Material::OWNER_MANAGER) || x.owner_type == Sketchup::Material::OWNER_MANAGER }
      unused_mats = m.materials.select { |x| managed.call(x) && !st['used_mats'][x] }
      unused_tags = m.layers.reject { |l| st['used_layers'][l] }
      keep = Array(p['keep_codes']).map { |c| c.to_s.upcase }
      cctx = { 'codes' => {} }
      std_unused = unused_tags.count { |l| keep.include?(mt_code(utf8(l.name), cctx)) } # empty standard tags purge keeps
      heavy_tex = m.materials.map do |x|
        t = x.texture
        next nil unless t && t.image_width * t.image_height > 2048 * 2048
        { 'name' => utf8(x.display_name), 'px' => [t.image_width, t.image_height] }
      end.compact
      heavy_defs = defs.map do |d|
        f = d.entities.count { |x| x.is_a?(Sketchup::Face) }
        { 'name' => utf8(d.name), 'faces' => f, 'instances' => used_n[d], 'total' => f * used_n[d] }
      end.sort_by { |h| -h['total'] }.first(5).select { |h| h['total'] > 0 }
      unit = (m.options['UnitsOptions']['LengthUnit'] rescue nil)
      hidden_tags = m.layers.reject { |l| l.visible? || l.get_attribute('su_mcp', 'section_tag') }.map { |l| tag_name(l) }
      path = m.path.to_s
      {
        'summary' => {
          'title' => utf8(m.title), 'path' => utf8(path), 'saved' => !path.empty?,
          'file_mb' => !path.empty? && File.exist?(path) ? (File.size(path) / 1048576.0).round(2) : nil,
          'length_unit' => unit ? UNIT_NAMES[unit] : nil, 'faces_in_definitions' => st['faces'], 'edges' => st['edges'],
          'definitions' => defs.size, 'materials' => m.materials.size, 'tags' => m.layers.size,
          'scenes' => m.pages.size, 'max_nesting' => st['depth']
        },
        'raw_top_faces' => st['raw_top'],
        'untagged_geometry' => { 'count' => st['untagged_n'], 'in' => st['untagged_in'] || [] },
        'raw_tagged' => { 'count' => st['raw_tagged'], 'in' => st['raw_tagged_in'] || [] },
        'inside_out' => { 'count' => st['inside_out_n'], 'items' => st['inside_out'] || [] },
        'mixed_orientation' => { 'count' => st['mixed'], 'in' => st['mixed_in'] || [] },
        'duplicates' => { 'count' => st['dups_n'], 'items' => st['dups'] || [] },
        'stray_edges' => { 'count' => st['stray'], 'in' => st['stray_in'] || [] },
        'tiny_edges' => st['tiny'],
        'unused' => { 'definitions' => unused_defs.map { |d| utf8(d.name) }.first(30), 'definitions_n' => unused_defs.size,
                      'materials' => unused_mats.map { |x| utf8(x.display_name) }.first(30), 'materials_n' => unused_mats.size,
                      'tags' => unused_tags.map { |l| tag_name(l) }.first(30), 'tags_n' => unused_tags.size,
                      'tags_standard_n' => std_unused },
        'heavy_textures' => heavy_tex, 'heavy_definitions' => heavy_defs,
        'hidden' => { 'objects' => st['hidden'], 'tags' => hidden_tags },
        'tags_in_use' => m.layers.select { |l| st['used_layers'][l] && !untagged?(l) }.map { |l| utf8(l.name) }
      }
    end

    # Purge unused components and materials, and unused tags - but keep empty tags of the given codes (the tag
    # standard set up with setup_tags, still waiting for objects). One Undo step.
    def self.ck_purge(p)
      m = model
      keep = Array(p['keep_codes']).map { |c| c.to_s.upcase }
      st = { 'visited' => {}, 'collections' => {}, 'solid_checked' => {}, 'used_layers' => {}, 'used_mats' => {},
             'faces' => 0, 'edges' => 0, 'stray' => 0, 'tiny' => 0, 'raw_tagged' => 0, 'raw_top' => 0, 'hidden' => 0,
             'depth' => 0, 'dups_n' => 0, 'untagged_n' => 0, 'inside_out_n' => 0, 'mixed' => 0 }
      ck_walk(m.entities, nil, 0, false, st)
      ctx = { 'codes' => {} }
      before = [m.definitions.size, m.materials.size]
      kept = []
      removed_tags = 0
      with_operation('purge unused') do |mm|
        mm.definitions.purge_unused
        mm.materials.purge_unused
        mm.layers.to_a.each do |l|
          next if l == mm.layers[0] || st['used_layers'][l]
          code = mt_code(utf8(l.name), ctx)
          if code && keep.include?(code)
            kept << utf8(l.name)
            next
          end
          mm.layers.remove(l)
          removed_tags += 1
        end
      end
      { 'purged' => { 'definitions' => before[0] - m.definitions.size, 'materials' => before[1] - m.materials.size,
                      'tags' => removed_tags }, 'kept_empty_standard_tags' => kept }
    end

    # ------------------------------------------------------------------
    # Rooms of the model (same rules as measure_tags): named untagged groups, levels holding rooms.
    # ------------------------------------------------------------------
    def self.rm_bounds(e, tr)
      bb = Geom::BoundingBox.new
      db = e.definition.bounds
      8.times { |i| bb.add(db.corner(i).transform(tr)) } unless db.empty?
      bb
    end

    def self.rm_find(ents, tr, path, level, ctx, out, levels)
      ents.each do |e|
        next unless mt_container?(e) && mt_visible?(e, ctx)
        own = untagged?(e.layer) ? nil : utf8(e.layer.name)
        next if own && mt_code(own, ctx) # a BOQ item, not a room
        d = e.definition
        next unless mt_holds_code?(d, ctx)
        wt = tr * e.transformation
        nm = utf8(e.name).strip
        if nm.empty?
          rm_find(d.entities, wt, path, level, ctx, out, levels)
        elsif mt_pure?(d, ctx)
          lv = path.empty? ? nm : "#{path} / #{nm}"
          levels << { 'name' => lv, 'entity' => e, 'bounds' => rm_bounds(e, wt) }
          rm_find(d.entities, wt, lv, lv, ctx, out, levels)
        else
          out << { 'name' => path.empty? ? nm : "#{path} / #{nm}", 'entity' => e, 'level' => level, 'bounds' => rm_bounds(e, wt) }
        end
      end
    end

    def self.rooms_of_model(ctx)
      out = []
      levels = []
      rm_find(model.entities, IDENTITY, '', nil, ctx, out, levels)
      [out, levels]
    end

    def self.light_ctx
      { 'hidden' => false, 'codes' => {}, 'shown' => {}, 'holds' => {}, 'pure' => {}, 'wrap' => {}, 'skipped' => {},
        'exclude' => [] }
    end

    # ------------------------------------------------------------------
    # create_scenes: documentation scenes from the tag standard and the rooms. Re-running replaces the scenes and
    # section planes it made before (attribute su_mcp/generated) for the same kinds and rooms. The user's view,
    # selected scene, style and display settings, shadows, axes, hidden objects, tag (and tag folder) visibility and
    # active section plane are restored afterwards. One Undo step.
    # ------------------------------------------------------------------
    SCENE_WORDS = {
      'en' => { 'plan' => 'Furniture plan', 'ceiling' => 'Reflected ceiling plan', 'floor' => 'Floor finish plan',
                'elev' => 'Elevation', 'persp' => 'View', 'look' => 'looking', 'sections' => 'Section planes' },
      'vi' => { 'plan' => "Mặt bằng bố trí", 'ceiling' => "Mặt bằng trần",
                'floor' => "Mặt bằng lát sàn", 'elev' => "Mặt đứng",
                'persp' => "Phối cảnh", 'look' => "nhìn về", 'sections' => "Mặt cắt" }
    }.freeze
    # A looks towards +Y, B +X, C -Y, D -X (the side of the room that is shown).
    ELEV_SIDES = [['A', [0, 1, 0], '+Y'], ['B', [1, 0, 0], '+X'], ['C', [0, -1, 0], '-Y'], ['D', [-1, 0, 0], '-X']].freeze
    VI_LETTERS = /[ơưạ-ỹ]/
    VI_WORDS = %r{(?:\A|[\s,.\-/])(?:phòng|khách|nhà|đá|đèn)(?=\z|[\s,.\-/])}

    def self.sc_mark(ent)
      ent.set_attribute('su_mcp', 'generated', true)
      ent
    end

    def self.cam_snapshot(c)
      snap = Sketchup::Camera.new(c.eye, c.target, c.up)
      snap.perspective = c.perspective?
      c.perspective? ? snap.fov = c.fov : snap.height = c.height
      snap.aspect_ratio = c.aspect_ratio if c.respond_to?(:aspect_ratio) && snap.respond_to?(:aspect_ratio=)
      snap
    end

    def self.tag_folders(l)
      out = []
      f = l.respond_to?(:folder) ? l.folder : nil
      while f
        out << f
        f = f.respond_to?(:folder) ? f.folder : nil
      end
      out
    end

    # Tag visibility for one scene: show = only these codes (tags with another code hidden), hide = these codes (all
    # other coded tags shown, whatever the current view: it may be a generated scene). Tags without a code keep the
    # visibility they had (they may hold a whole level). A shown tag's folders are shown.
    def self.sc_tags(vis, fvis, ctx, show, hide)
      want_f = {}
      vis.each do |l, was|
        next if l == model.layers[0]
        code = mt_code(utf8(l.name), ctx)
        v = if code.nil?
              was
            elsif show
              show.include?(code)
            else
              !hide.include?(code)
            end
        l.visible = v unless l.visible? == v
        tag_folders(l).each { |f| want_f[f] = true } if v && show && code
      end
      fvis.each do |f, was|
        v = want_f[f] ? true : was
        f.visible = v if f.respond_to?(:visible=) && f.visible? != v
      end
    end

    # Camera looking along dir at the world box bb (parallel: the box fills the view; perspective: from eye).
    def self.sc_frame(bb, dir, up)
      view = model.active_view
      ctr = bb.center
      d = Geom::Vector3d.new(dir[0], dir[1], dir[2]).normalize
      u = up.normalize
      r = d.cross(u).normalize
      ext_u = ext_r = 0.0
      8.times do |i|
        v = bb.corner(i) - ctr
        ext_u = [ext_u, dot(v, u).abs].max
        ext_r = [ext_r, dot(v, r).abs].max
      end
      aspect = view.vpheight > 0 ? view.vpwidth.to_f / view.vpheight : 1.5
      eye = ctr.offset(d.reverse, [bb.diagonal, 1000.mm].max * 2)
      cam = Sketchup::Camera.new(eye, ctr, u)
      cam.perspective = false
      cam.height = [2 * ext_u, 2 * ext_r / aspect, 100.mm].max * 1.08
      view.camera = cam
    end

    def self.sc_section(pt, normal, name, tag, kind, room)
      sp = model.entities.add_section_plane([pt, normal])
      sc_mark(sp)
      sc_scope(sp, kind, room)
      sp.name = name if sp.respond_to?(:name=)
      sp.layer = tag if tag
      model.entities.active_section_plane = sp
      sp
    end

    # Tag of the generated section planes, made hidden: an active section plane on a hidden tag still cuts, and
    # the planes do not clutter any view. The user's own scenes get it hidden too (new tags show in old scenes).
    def self.sc_section_tag(name)
      m = model
      t = m.layers.find { |l| l.get_attribute('su_mcp', 'section_tag') }
      return t if t
      nm = name
      nm = m.layers.respond_to?(:unique_name) ? m.layers.unique_name(nm) : "#{nm} (MCP)" if m.layers[nm]
      t = m.layers.add(nm)
      t.visible = false
      m.pages.each { |pg| pg.set_visibility(t, false) if pg.respond_to?(:set_visibility) }
      t.set_attribute('su_mcp', 'section_tag', true)
      t
    end

    # All tag folders, nested ones too (Layers#folders only lists the top ones). SketchUp 2021+.
    def self.sc_all_folders(holder, out = [])
      return out unless holder.respond_to?(:folders)
      holder.folders.each do |f|
        out << f
        sc_all_folders(f, out)
      end
      out
    end

    # Levels a generated plan hid (the user may be on such a scene) are shown while scenes are made; re-hidden after.
    def self.sc_unhide_levels(ents, out)
      ents.each do |e|
        next unless mt_container?(e) && untagged?(e.layer)
        lvl = e.get_attribute('su_mcp', 'level')
        if lvl && e.hidden?
          e.hidden = false
          out << e
        end
        sc_unhide_levels(e.definition.entities, out) if lvl || utf8(e.name).strip.empty?
      end
    end

    # The style the generated scenes use: the selected one, unless it is the ceiling plan's X-ray style (the user is on
    # that scene), then the style that one was made from.
    def self.sc_base_style(st)
      return st unless st && st.get_attribute('su_mcp', 'generated_style')
      own = model.styles.to_a.reject { |x| x.get_attribute('su_mcp', 'generated_style') }
      own.find { |x| x.name == st.get_attribute('su_mcp', 'base_style') } || own.first || st
    end

    # Hidden objects and geometry (top level and every definition) by id: selecting the user's scene again at the end
    # re-applies what it saved, so the state from before the run is put back from this.
    def self.sc_hidden_set
      out = {}
      add = lambda { |ents| ents.each { |e| out[e.entityID] = e if e.respond_to?(:hidden?) && e.hidden? } }
      add.call(model.entities)
      model.definitions.each { |d| add.call(d.entities) unless d.image? }
      out
    end

    def self.sc_shadow_snapshot
      out = {}
      model.shadow_info.each { |k, v| out[k] = v }
      out
    end

    def self.sc_shadow_restore(snap)
      si = model.shadow_info
      snap.each do |k, v|
        begin
          si[k] = v unless si[k] == v
        rescue StandardError
          nil # read-only keys
        end
      end
    end

    def self.sc_ro_apply(settings)
      ro = model.rendering_options
      settings.each do |k, v|
        begin
          ro[k] = v unless ro[k] == v
        rescue StandardError
          nil
        end
      end
    end

    # A style file shipped with SketchUp, to make a style from (the API cannot make one from nothing).
    def self.sc_style_file
      year = 2000 + Sketchup.version.to_i
      dirs = []
      dirs << File.join(ENV['ProgramData'], 'SketchUp', "SketchUp #{year}", 'SketchUp', 'Styles') if ENV['ProgramData']
      dirs << "/Library/Application Support/SketchUp #{year}/SketchUp/Styles"
      res = Sketchup.respond_to?(:get_resource_path) ? Sketchup.get_resource_path('').to_s : ''
      dirs << File.expand_path(File.join(res, '..', 'Content', 'Styles')) unless res.empty?
      dirs << Sketchup.find_support_file('Styles')
      files = dirs.compact.map { |d| d.tr('\\', '/') }.select { |d| File.directory?(d) }.flat_map do |d|
        Dir.glob(File.join(d, '**', '*.style'))
      end
      files = files.sort
      files.find { |f| File.basename(f) =~ /default style/i } || files.find { |f| File.basename(f) =~ /simple style/i } ||
        files.find { |f| File.basename(f) =~ /\A00/ } || files.find { |f| f =~ %r{/default styles/}i } || files.first
    rescue StandardError
      nil
    end

    # The ceiling plan's style: the user's display settings plus X-ray. A scene applies its style's saved settings,
    # so X-ray needs a style of its own; it is made once and refreshed on every run. Leaves it selected (nil if none).
    def self.sc_xray_style(name, settings, base)
      m = model
      st = m.styles.find { |s| s.get_attribute('su_mcp', 'generated_style') == 'ceiling' }
      fresh = st.nil?
      if fresh
        file = sc_style_file
        return nil unless file
        before = m.styles.to_a
        m.styles.add_style(file, false)
        st = (m.styles.to_a - before).first
        return nil unless st
        st.name = name
        st.set_attribute('su_mcp', 'generated_style', 'ceiling')
      end
      st.set_attribute('su_mcp', 'base_style', base.name) if base
      m.styles.selected_style = st
      sc_ro_apply(settings.merge('ModelTransparency' => true))
      m.styles.update_selected_style
      st.name = name if fresh && st.name != name
      st
    end

    def self.sc_scope(ent, kind, room)
      ent.set_attribute('su_mcp', 'kind', kind)
      ent.set_attribute('su_mcp', 'room', room.to_s)
    end

    # Where to cut an elevation looking along dir: just in front of the wall behind the viewer. Rays from inside the room
    # towards that wall find its inner face (a finish panel or a thick wall drawn in the room group); the cut goes 30 mm in
    # front of the nearest hit within 600 mm of the room's edge. Without a hit: 30 mm inside the edge.
    def self.sc_elev_cut(bb, dir, zf)
      ax = dir[0].nonzero? ? 0 : 1
      cr = 1 - ax
      sign = dir[ax] > 0 ? 1 : -1
      back = sign > 0 ? bb.min[ax] : bb.max[ax]
      depth = bb.max[ax] - bb.min[ax]
      span = bb.max[cr] - bb.min[cr]
      h = [bb.max.z - zf, 100.mm].max
      ray_dir = Geom::Vector3d.new(-dir[0], -dir[1], 0)
      best = nil
      [0.25, 0.5, 0.75].each do |fa|
        [0.6, 0.85].each do |fz|
          c = [0, 0, zf + h * fz]
          c[ax] = bb.center[ax]
          c[cr] = bb.min[cr] + span * fa
          hit = model.raytest([Geom::Point3d.new(*c), ray_dir], true)
          next unless hit
          inward = (hit[0][ax] - back) * sign
          next if inward < -1.mm || inward > [600.mm, depth / 2.0].min
          best = inward if best.nil? || inward < best
        end
      end
      back + sign * ([best || 0, 0].max + 30.mm)
    end

    # Eye and target of a room's perspective at eye height: 12 % in from a corner of the room's box, the first corner
    # that is inside the room (a ray down hits the room, e.g. not the notch of an L-shaped room), towards the opposite one.
    def self.sc_persp(r, bb, zf)
      z = zf + 1600.mm
      [[0, 0], [1, 1], [0, 1], [1, 0]].each do |cx, cy|
        eye = Geom::Point3d.new(cx.zero? ? bb.min.x + bb.width * 0.12 : bb.max.x - bb.width * 0.12,
                                cy.zero? ? bb.min.y + bb.height * 0.12 : bb.max.y - bb.height * 0.12, z)
        hit = model.raytest([eye, Geom::Vector3d.new(0, 0, -1)], true)
        next unless hit && hit[1].include?(r['entity']) && hit[0].z >= bb.min.z - 1.mm
        tgt = Geom::Point3d.new(cx.zero? ? bb.max.x - bb.width * 0.15 : bb.min.x + bb.width * 0.15,
                                cy.zero? ? bb.max.y - bb.height * 0.15 : bb.min.y + bb.height * 0.15, z)
        return [eye, tgt]
      end
      [Geom::Point3d.new(bb.min.x + bb.width * 0.12, bb.min.y + bb.height * 0.12, z),
       Geom::Point3d.new(bb.max.x - bb.width * 0.15, bb.max.y - bb.height * 0.15, z)]
    end

    def self.sc_page(name, kind, room, desc, out)
      pg = model.pages.add(name)
      sc_mark(pg)
      sc_scope(pg, kind, room)
      pg.description = desc.to_s if desc
      out << { 'name' => utf8(pg.name), 'kind' => kind, 'room' => room }
      pg
    end

    # Finished floor level of a set of rooms: top of their FL objects (else the bottom of the box).
    def self.sc_ffl(objs, names, bb)
      tops = objs.select { |o| o['code'] == 'FL' && (names.nil? || names.include?(o['room'])) }.map { |o| o['zmax'] }
      tops.empty? ? bb.min.z : tops.min
    end

    def self.cmd_create_scenes(p)
      m = model
      view = m.active_view
      kinds = Array(p['kinds']).map(&:to_s)
      kinds = %w[plan ceiling floor elevations perspectives] if kinds.empty?
      cut = num(p['cut_height'] || 1200, 'cut_height').mm
      codes = p['codes'].is_a?(Hash) ? p['codes'] : {}
      only = Array(p['rooms']).map(&:to_s)
      snap = cam_snapshot(view.camera)
      vis = {}
      m.layers.each { |l| vis[l] = l.visible? }
      fvis = {}
      sc_all_folders(m.layers).each { |f| fvis[f] = f.visible? }
      old_sp = m.entities.active_section_plane
      ro = m.rendering_options
      settings = {} # the user's display settings (with unsaved style changes), restored at the end
      ro.each { |k, v| settings[k] = v }
      old_style = m.styles.selected_style
      base_style = sc_base_style(old_style)
      old_page = m.pages.selected_page
      old_layer = m.active_layer
      shadow = sc_shadow_snapshot
      axes = m.respond_to?(:axes) ? [m.axes.origin, m.axes.xaxis, m.axes.yaxis, m.axes.zaxis] : nil
      hidden0 = sc_hidden_set
      popts = m.options['PageOptions']
      old_trans = popts ? popts['ShowTransition'] : nil
      out = []
      removed = 0
      notes = []
      sec_tag = nil
      xray = nil
      xray_tried = false
      rooms = levels = objs = lang = w = nil
      unhidden = []
      with_operation('create_scenes') do |_mm|
        begin
          m.active_layer = m.layers[0] # section planes go on their own tag, whatever tag is active
          sc_unhide_levels(m.entities, unhidden)
          ctx = light_ctx.merge('objs' => [], 'kids' => {})
          rooms, levels = rooms_of_model(ctx)
          levels.each { |lv| lv['entity'].set_attribute('su_mcp', 'level', true) }
          rooms = rooms.select { |r| only.include?(r['name']) || only.any? { |o| r['name'].end_with?(" / #{o}") } } unless only.empty?
          dc_walk(m.entities, IDENTITY, nil, [], ctx, '', nil, true, [])
          objs = ctx['objs']
          lang = p['language'].to_s
          lang = rooms.any? { |r| n = fold(r['name']); n =~ VI_LETTERS || n =~ VI_WORDS } ? 'vi' : 'en' unless %w[en vi].include?(lang)
          w = SCENE_WORDS[lang].merge(p['labels'].is_a?(Hash) ? p['labels'].reject { |_, v| v.to_s.empty? } : {})
          # generated scenes use the user's style, not the X-ray one when the user is on the ceiling plan
          base_settings = settings
          if base_style != old_style
            m.styles.selected_style = base_style
            base_settings = {}
            ro.each { |k, v| base_settings[k] = v }
          end
          if p['replace'] != false
            # replace what an earlier call made for the same kinds (and, for elevations and views, the same rooms)
            want = kinds.map { |k| { 'elevations' => 'elevation', 'perspectives' => 'perspective' }[k] || k }
            names = rooms.map { |r| r['name'] }
            gone = lambda do |ent|
              next false unless ent.get_attribute('su_mcp', 'generated')
              k = ent.get_attribute('su_mcp', 'kind')
              next true if k.nil?
              next false unless want.include?(k)
              %w[plan floor ceiling].include?(k) || only.empty? || names.include?(ent.get_attribute('su_mcp', 'room').to_s)
            end
            m.pages.to_a.each do |pg|
              next unless gone.call(pg)
              m.pages.erase(pg)
              removed += 1
            end
            m.entities.grep(Sketchup::SectionPlane).each { |sp| sp.erase! if gone.call(sp) }
          end
          sec_tag = sc_section_tag(w['sections'])
          plan_sets = levels.empty? ? [[nil, m.bounds, nil]] : levels.map { |lv| [lv['name'], lv['bounds'], lv] }
          plan_sets.each do |lname, bb, lv|
            next if bb.empty?
            suffix = lname ? " - #{lname}" : ''
            in_level = lname ? rooms_of_level(rooms, lname) : nil
            zf = sc_ffl(objs, in_level, bb)
            ctr = bb.center
            others = lname ? levels.reject { |x| x['name'] == lname || lname.start_with?("#{x['name']} / ") || x['name'].start_with?("#{lname} / ") }.map { |x| x['entity'] } : []
            others.each { |e| e.hidden = true }
            begin
              if kinds.include?('plan')
                sc_tags(vis, fvis, ctx, nil, Array(codes['plan_hide']))
                sc_section(Geom::Point3d.new(ctr.x, ctr.y, zf + cut), Geom::Vector3d.new(0, 0, -1), "#{w['plan']}#{suffix}", sec_tag, 'plan', lname)
                sc_frame(bb, [0, 0, -1], Y_AXIS)
                sc_page("#{w['plan']}#{suffix}", 'plan', lname, nil, out)
              end
              if kinds.include?('floor')
                sc_tags(vis, fvis, ctx, Array(codes['floor_show']), nil)
                sc_section(Geom::Point3d.new(ctr.x, ctr.y, zf + cut), Geom::Vector3d.new(0, 0, -1), "#{w['floor']}#{suffix}", sec_tag, 'floor', lname)
                sc_frame(bb, [0, 0, -1], Y_AXIS)
                sc_page("#{w['floor']}#{suffix}", 'floor', lname, nil, out)
              end
              if kinds.include?('ceiling')
                # seen from above in X-ray with only the ceiling tags: same orientation as the plan, lights visible
                sc_tags(vis, fvis, ctx, Array(codes['ceiling_show']), nil)
                m.entities.active_section_plane = nil
                sc_frame(bb, [0, 0, -1], Y_AXIS)
                begin
                  if xray_tried
                    m.styles.selected_style = xray if xray
                  else
                    xray_tried = true
                    xray = sc_xray_style("#{w['ceiling']} (X-ray)", base_settings, base_style)
                  end
                  sc_page("#{w['ceiling']}#{suffix}", 'ceiling', lname, nil, out)
                ensure
                  if base_style && base_style.valid? && m.styles.selected_style != base_style
                    m.styles.selected_style = base_style
                    sc_ro_apply(base_settings)
                  end
                end
              end
            ensure
              others.each { |e| e.hidden = false if e.valid? }
            end
          end
          if kinds.include?('elevations') || kinds.include?('perspectives')
            sc_tags(vis, fvis, ctx, nil, Array(codes['view_hide']))
            rooms.each do |r|
              bb = r['bounds']
              next if bb.empty?
              ctr = bb.center
              zf = sc_ffl(objs, [r['name']], bb)
              if kinds.include?('elevations')
                ELEV_SIDES.each do |letter, dir, label|
                  # cut just in front of the wall behind the viewer, keep what is in front of the cut
                  m.entities.active_section_plane = nil
                  v = sc_elev_cut(bb, dir, zf)
                  pt = dir[0].nonzero? ? Geom::Point3d.new(v, ctr.y, ctr.z) : Geom::Point3d.new(ctr.x, v, ctr.z)
                  sc_section(pt, Geom::Vector3d.new(*dir), "#{w['elev']} #{r['name']} - #{letter}", sec_tag, 'elevation', r['name'])
                  sc_frame(bb, dir, Z_AXIS)
                  sc_page("#{w['elev']} #{r['name']} - #{letter}", 'elevation', r['name'], "#{w['look']} #{label}", out)
                end
              end
              next unless kinds.include?('perspectives')
              m.entities.active_section_plane = nil
              eye, tgt = sc_persp(r, bb, zf)
              cam = Sketchup::Camera.new(eye, tgt, Z_AXIS)
              cam.perspective = true
              cam.fov = 60.0
              view.camera = cam
              sc_page("#{w['persp']} #{r['name']}", 'perspective', r['name'], nil, out)
            end
          end
        ensure
          # back to the user's state: their scene tab first (without its animation), then their style, display settings,
          # shadows, axes, hidden objects, tags, section and view (selecting the scene re-applied what it saved)
          popts['ShowTransition'] = false if popts
          m.pages.selected_page = old_page if old_page && old_page.valid?
          m.styles.selected_style = old_style if old_style && old_style.valid? && m.styles.selected_style != old_style
          sc_ro_apply(settings)
          sc_shadow_restore(shadow)
          m.axes.set(*axes) if axes && [m.axes.origin, m.axes.xaxis, m.axes.yaxis, m.axes.zaxis] != axes
          now = sc_hidden_set
          now.each { |id, e| e.hidden = false if !hidden0.key?(id) && e.valid? }
          hidden0.each { |id, e| e.hidden = true if !now.key?(id) && e.valid? }
          vis.each { |l, was| l.visible = was if l.valid? && l.visible? != was }
          fvis.each { |f, was| f.visible = was if f.valid? && f.respond_to?(:visible=) && f.visible? != was }
          m.entities.active_section_plane = old_sp && old_sp.valid? ? old_sp : nil
          view.camera = snap
          popts['ShowTransition'] = old_trans if popts && !old_trans.nil?
          m.active_layer = old_layer if old_layer && old_layer.valid?
        end
      end
      if kinds.include?('ceiling') && out.any? { |x| x['kind'] == 'ceiling' } && xray.nil?
        notes << 'No SketchUp style file was found to give the ceiling plan an X-ray style of its own: turn on X-ray ' \
                 '(View > Face Style > X-ray) when you look at it.'
      end
      unless settings['DisplaySectionCuts']
        notes << 'Section cuts are turned off (View > Section Cuts): turn them on to see the plans and elevations cut.'
      end
      if rooms.empty? && (kinds & %w[elevations perspectives]).any?
        notes << 'No rooms found (named groups without a tag holding tagged objects): no elevations or perspectives.'
      end
      { 'scenes' => out, 'removed_old' => removed, 'rooms' => rooms.map { |r| r['name'] },
        'levels' => levels.map { |l| l['name'] }, 'language' => lang,
        'section_tag' => sec_tag && sec_tag.valid? ? utf8(sec_tag.name) : nil,
        'ceiling_style' => xray && xray.valid? ? utf8(xray.name) : nil, 'notes' => notes }
    end

    def self.rooms_of_level(rooms, lname)
      rooms.select { |r| r['level'] == lname || r['name'].start_with?("#{lname} / ") }.map { |r| r['name'] }
    end

    # ------------------------------------------------------------------
    # check_design: design checks on the tagged objects (read only). Objects are taken like interior_takeoff
    # counts them (outermost object per tag) with their bounding box in their own axes, in world coordinates.
    # ------------------------------------------------------------------
    def self.dc_box(e, wt)
      bb = e.definition.bounds
      return nil if bb.empty?
      a = wt.to_a
      w = a[15].to_f
      w = 1.0 if w.abs < 1e-12
      cols = [[a[0], a[1], a[2]], [a[4], a[5], a[6]], [a[8], a[9], a[10]]].map { |v| v.map { |x| x / w } }
      ext = [bb.width, bb.height, bb.depth]
      axes = []
      half = []
      3.times do |i|
        len = Math.sqrt(cols[i][0]**2 + cols[i][1]**2 + cols[i][2]**2)
        len = 1.0 if len < 1e-12
        axes << Geom::Vector3d.new(cols[i][0] / len, cols[i][1] / len, cols[i][2] / len)
        half << ext[i] * len / 2.0
      end
      ctr = bb.center.transform(wt)
      zh = (0..2).inject(0.0) { |s, i| s + axes[i].z.abs * half[i] }
      up = (0..2).max_by { |i| axes[i].z.abs }
      hz = (0..2).to_a - [up]
      { 'c' => ctr, 'ax' => axes, 'h' => half, 'zmin' => ctr.z - zh, 'zmax' => ctr.z + zh, 'up' => up,
        'height' => 2 * half[up], 'plan' => hz.map { |i| 2 * half[i] }, 'thick' => 2 * half.min }
    end

    # Overlap of two oriented boxes (separating axis test): the distance needed to push them apart, 0 or less
    # when they do not interpenetrate.
    def self.dc_overlap(a, b)
      d = b['c'] - a['c']
      best = nil
      test = lambda do |l|
        ra = (0..2).inject(0.0) { |s, i| s + a['h'][i] * dot(a['ax'][i], l).abs }
        rb = (0..2).inject(0.0) { |s, i| s + b['h'][i] * dot(b['ax'][i], l).abs }
        ra + rb - dot(d, l).abs
      end
      (a['ax'] + b['ax']).each do |l|
        o = test.call(l)
        return o if o <= 0
        best = o if best.nil? || o < best
      end
      # the 9 edge-edge axes only when the 6 face axes do not separate the boxes
      a['ax'].each do |x|
        b['ax'].each do |y|
          v = x.cross(y)
          next unless v.length > 1e-6
          o = test.call(v.normalize)
          return o if o <= 0
          best = o if o < best
        end
      end
      best
    end

    # World axis-aligned plan box of an oriented box: [minx, maxx, miny, maxy].
    def self.dc_aabb(o)
      ex = (0..2).inject(0.0) { |s, i| s + o['ax'][i].x.abs * o['h'][i] }
      ey = (0..2).inject(0.0) { |s, i| s + o['ax'][i].y.abs * o['h'][i] }
      [o['c'].x - ex, o['c'].x + ex, o['c'].y - ey, o['c'].y + ey]
    end

    def self.dc_aabb_apart?(a, b, margin = 0.0)
      a[0] > b[1] + margin || b[0] > a[1] + margin || a[2] > b[3] + margin || b[2] > a[3] + margin
    end

    # Pairs whose boxes come within `margin` of each other in plan and overlap in height (sweep along x): keeps large
    # models fast, and objects of different levels apart.
    def self.dc_near_pairs(list, margin)
      boxes = list.map { |o| [o, dc_aabb(o)] }.sort_by { |_, b| b[0] }
      out = []
      boxes.each_with_index do |(a, ba), i|
        j = i + 1
        while j < boxes.size && boxes[j][1][0] <= ba[1] + margin
          b, bb = boxes[j]
          out << [a, b] if bb[2] <= ba[3] + margin && ba[2] <= bb[3] + margin && a['zmin'] < b['zmax'] && b['zmin'] < a['zmax']
          j += 1
        end
      end
      out
    end

    # Plan footprint of a box: 4 corners (x, y) of its two horizontal-most axes.
    def self.dc_footprint(b)
      i, j = ((0..2).to_a - [b['up']])
      c = b['c']
      u = b['ax'][i]
      v = b['ax'][j]
      hu = b['h'][i]
      hv = b['h'][j]
      [[1, 1], [1, -1], [-1, -1], [-1, 1]].map { |s, t| [c.x + s * u.x * hu + t * v.x * hv, c.y + s * u.y * hu + t * v.y * hv] }
    end

    def self.dc_seg_dist(p, a, b)
      dx = b[0] - a[0]
      dy = b[1] - a[1]
      l2 = dx * dx + dy * dy
      t = l2 > 0 ? (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2) : 0.0
      t = [[t, 0.0].max, 1.0].min
      Math.sqrt((p[0] - a[0] - t * dx)**2 + (p[1] - a[1] - t * dy)**2)
    end

    def self.dc_inside(p, poly)
      sign = nil
      poly.each_with_index do |a, k|
        b = poly[(k + 1) % poly.size]
        cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        next if cr.abs < 1e-9
        s = cr > 0
        return false if !sign.nil? && s != sign
        sign = s
      end
      true
    end

    # Plan distance (inches) between two convex footprints; 0 when they overlap or cross.
    def self.dc_plan_dist(pa, pb)
      return 0.0 if pa.any? { |p| dc_inside(p, pb) } || pb.any? { |p| dc_inside(p, pa) }
      pa.each_with_index do |a1, i|
        a2 = pa[(i + 1) % 4]
        pb.each_with_index { |b1, j| return 0.0 if seg_cross?(a1, a2, b1, pb[(j + 1) % 4]) }
      end
      best = nil
      [[pa, pb], [pb, pa]].each do |p1, p2|
        p1.each do |p|
          p2.each_with_index do |a, k|
            dd = dc_seg_dist(p, a, p2[(k + 1) % p2.size])
            best = dd if best.nil? || dd < best
          end
        end
      end
      best
    end

    def self.dc_walk(ents, tr, key, counted, ctx, room, culprit, pure, anc, defn0 = nil)
      kids = if defn0
               (ctx['kids'] ||= {})[defn0] ||= ents.select { |x| mt_container?(x) }
             else
               ents.select { |x| mt_container?(x) }
             end
      kids.each do |e|
        ekey = mt_key(e, key, ctx)
        next if mt_excluded?(ekey, ctx) || mt_skip(e, ekey, ctx)
        wt = tr * e.transformation
        nm = utf8(e.name).strip
        defn = e.definition
        if ekey == 'Untagged' || (key.nil? && mt_code(ekey, ctx).nil? && mt_holds_code?(defn, ctx))
          if !nm.empty? && (room.empty? || pure) && (culprit.nil? || mt_holds_code?(defn, ctx))
            dc_walk(defn.entities, wt, nil, counted, ctx, room.empty? ? nm : "#{room} / #{nm}", nil, mt_pure?(defn, ctx),
                    anc + [e.entityID], defn)
          else
            dc_walk(defn.entities, wt, nil, counted, ctx, room, ekey == 'Untagged' ? (culprit || e) : culprit, nm.empty? ? pure : false,
                    anc + [e.entityID], defn)
          end
          next
        end
        first = !counted.include?(ekey)
        if first && mt_wrapper?(defn, ekey, ctx)
          dc_walk(defn.entities, wt, ekey, counted, ctx, room, culprit, false, anc + [e.entityID], defn)
          next
        end
        eroom = room
        if first
          eroom = mt_room_from_name(nm, ekey, ctx) if room.empty?
          box = dc_box(e, wt)
          if box
            label = nm.empty? ? utf8(defn.name) : nm
            ctx['objs'] << box.merge('id' => e.entityID, 'name' => label, 'def' => utf8(defn.name), 'tag' => ekey,
                                     'code' => mt_code(ekey, ctx), 'room' => eroom, 'path' => anc + [e.entityID])
          end
        end
        # nothing below an item matters unless it holds another tagged item
        next unless mt_holds_code?(defn, ctx)
        dc_walk(defn.entities, wt, ekey, first ? counted + [ekey] : counted, ctx, eroom, culprit, false, anc + [e.entityID], defn)
      end
    end

    def self.cmd_check_design(p)
      lim = p['limits'].is_a?(Hash) ? p['limits'] : {}
      g = lambda { |k, d| (lim[k] || d).to_f.mm }
      min_h = g.call('min_ceiling_height_mm', 2400)
      min_local = g.call('min_local_height_mm', 2100)
      min_dw = g.call('min_door_width_mm', 700)
      min_dh = g.call('min_door_height_mm', 1950)
      min_pass = g.call('min_passage_mm', 600)
      min_low = g.call('min_passage_low_mm', 300)
      ignore_gap = g.call('ignore_gap_mm', 100)
      tol = g.call('clash_tolerance_mm', 10)
      max_wall = g.call('max_wall_thickness_mm', 600)
      checks = Array(p['checks']).map(&:to_s)
      checks = %w[ceiling_height doors clashes passages door_clearance kitchen] if checks.empty?
      groups = p['groups'].is_a?(Hash) ? p['groups'] : {}
      furn = Array(groups['furniture'] || %w[FN JN EQ SN])
      wallc = Array(groups['walls'] || %w[WL PA GL EX])
      built_in = Array(groups['built_in'] || %w[EQ SN])
      sliding = Array(p['sliding_words']).map { |x| fold(x) }
      ctx = light_ctx.merge('hidden' => p['include_hidden'] ? true : false,
                            'exclude' => Array(p['exclude_codes']).map { |c| c.to_s.upcase }, 'objs' => [])
      dc_walk(model.entities, IDENTITY, nil, [], ctx, '', nil, true, [])
      objs = ctx['objs']
      issues = []
      mm = lambda { |v| to_mm(v).round }
      ref = lambda { |o| { 'id' => o['id'], 'name' => o['name'], 'tag' => o['tag'] } }
      inside = lambda { |p, q| p.size < q.size && q[0, p.size] == p }
      nested = lambda { |a, b| inside.call(a['path'], b['path']) || inside.call(b['path'], a['path']) }
      by_room = objs.group_by { |o| o['room'] }
      floor_z = {}
      by_room.each do |room, list|
        fl = list.select { |o| o['code'] == 'FL' }
        floor_z[room] = fl.empty? ? list.map { |o| o['zmin'] }.min : fl.map { |o| o['zmax'] }.max
      end
      skipped_checks = [] # checks that could not run, so that "no issue" is not read as "compliant"
      if checks.include?('ceiling_height')
        bare = []
        by_room.each do |room, list|
          next if room.to_s.empty?
          fl = list.select { |o| o['code'] == 'FL' }
          cl = list.select { |o| o['code'] == 'CL' }
          if fl.empty? || cl.empty?
            bare << room
            next
          end
          ffl = fl.map { |o| o['zmax'] }.max
          main = cl.max_by { |o| o['plan'][0] * o['plan'][1] }
          clear = main['zmin'] - ffl
          if clear < min_h - 0.5.mm
            issues << { 'check' => 'ceiling_height', 'severity' => 'warning', 'room' => room, 'value_mm' => mm.call(clear),
                        'limit_mm' => mm.call(min_h), 'objects' => [ref.call(main)] }
          end
          low = cl.min_by { |o| o['zmin'] }
          lclear = low['zmin'] - ffl
          next unless lclear < min_local - 0.5.mm
          issues << { 'check' => 'ceiling_height_local', 'severity' => 'warning', 'room' => room, 'value_mm' => mm.call(lclear),
                      'limit_mm' => mm.call(min_local), 'objects' => [ref.call(low)] }
        end
        unless bare.empty?
          skipped_checks << "Ceiling height not checked in #{bare.first(20).join(', ')}#{bare.size > 20 ? ', ...' : ''}: " \
                            'the room needs a floor finish (FL) and a ceiling (CL) object.'
        end
        if by_room.keys.all? { |r| r.to_s.empty? } && !objs.empty?
          skipped_checks << 'Ceiling heights not checked: no rooms (named groups without a tag that hold the tagged objects).'
        end
      end
      doors = objs.select { |o| o['code'] == 'DR' }
      if checks.include?('doors')
        doors.each do |o|
          width = o['plan'].max
          if width < min_dw - 0.5.mm
            issues << { 'check' => 'door_width', 'severity' => 'warning', 'room' => o['room'], 'value_mm' => mm.call(width),
                        'limit_mm' => mm.call(min_dw), 'objects' => [ref.call(o)] }
          end
          next unless o['height'] < min_dh - 0.5.mm
          issues << { 'check' => 'door_height', 'severity' => 'warning', 'room' => o['room'], 'value_mm' => mm.call(o['height']),
                      'limit_mm' => mm.call(min_dh), 'objects' => [ref.call(o)] }
        end
      end
      is_f = lambda { |o| furn.include?(o['code']) }
      fobjs = objs.select { |o| is_f.call(o) && o['height'] > 50.mm } # rugs and other flat pieces are not checked
      wall_all = objs.select { |o| wallc.include?(o['code']) }
      # a wall object must be one thin run to be checked; a whole flat or room drawn as one group is listed instead
      wobjs = wall_all.select { |o| o['thick'] <= max_wall }
      not_checked = (wall_all - wobjs).first(20).map(&ref)
      if checks.include?('clashes')
        pairs = dc_near_pairs(fobjs + wobjs, tol).select do |a, b|
          next false unless is_f.call(a) || is_f.call(b)
          !((built_in.include?(a['code']) && b['code'] == 'JN') || (built_in.include?(b['code']) && a['code'] == 'JN'))
        end
        pairs.each do |a, b|
          next if nested.call(a, b)
          next if a['zmax'] <= b['zmin'] || b['zmax'] <= a['zmin']
          o = dc_overlap(a, b)
          next unless o && o > tol
          # two pieces of furniture overlapping may be intended (a chair under a table): info only
          sev = is_f.call(a) && is_f.call(b) ? 'info' : 'warning'
          issues << { 'check' => 'clash', 'severity' => sev, 'room' => a['room'], 'value_mm' => mm.call(o),
                      'limit_mm' => mm.call(tol), 'objects' => [ref.call(a), ref.call(b)] }
          break if issues.size > 500
        end
      end
      if checks.include?('passages')
        big = fobjs.select do |o|
          fz = floor_z[o['room']] || o['zmin']
          o['height'] >= 300.mm && o['zmin'] - fz < 300.mm && (o['plan'].max >= 1000.mm || o['plan'][0] * o['plan'][1] >= 0.4 / IN2_TO_M2)
        end
        tall_walls = wobjs.select { |o| o['height'] >= 1000.mm }
        bigset = {}
        big.each { |o| bigset[o['id']] = true }
        fp = {}
        dc_near_pairs(big + tall_walls, min_pass).each do |a, b|
          next unless bigset[a['id']] || bigset[b['id']]
          next if nested.call(a, b) || a['room'] != b['room']
          wall_pair = !(bigset[a['id']] && bigset[b['id']])
          piece = bigset[a['id']] ? a : b
          other = piece.equal?(a) ? b : a
          low = piece['height'] < 550.mm || (!wall_pair && other['height'] < 550.mm)
          next if wall_pair && low # a bed or a low unit against a wall: the gap is not a passage
          limit = low ? min_low : min_pass
          d = dc_plan_dist(fp[a.object_id] ||= dc_footprint(a), fp[b.object_id] ||= dc_footprint(b))
          next unless d > ignore_gap && d < limit
          issues << { 'check' => 'passage', 'severity' => 'warning', 'room' => a['room'], 'value_mm' => mm.call(d),
                      'limit_mm' => mm.call(limit), 'objects' => [ref.call(a), ref.call(b)] }
        end
      end
      if checks.include?('door_clearance')
        doors.each do |dr|
          label = fold("#{dr['name']} #{dr['def']} #{dr['tag']}")
          next if sliding.any? { |x| label.include?(x) } # sliding and pocket doors do not swing
          hz = (0..2).to_a - [dr['up']]
          thin = hz.min_by { |i| dr['h'][i] }
          wide = (hz - [thin]).first
          wd = dr['h'][wide] * 2
          depth = wd > 1200.mm ? wd / 2.0 : wd # a double door: each leaf sweeps half the width
          hits = []
          [-1, 1].each do |side|
            c = dr['c'].offset(dr['ax'][thin], side * (dr['h'][thin] + depth / 2.0))
            zone = { 'c' => c, 'ax' => dr['ax'], 'h' => dr['h'].dup.tap { |h| h[thin] = depth / 2.0 } }
            zb = dc_aabb(zone)
            blocked = fobjs.select do |f|
              next false if nested.call(f, dr) || dc_aabb_apart?(zb, f['aabb'] ||= dc_aabb(f))
              o = dc_overlap(zone, f)
              o && o > tol
            end
            hits << blocked
          end
          next if hits.all?(&:empty?)
          sev = hits.none?(&:empty?) ? 'warning' : 'info' # both sides blocked: the door cannot open either way
          hits.flatten.uniq.each do |f|
            issues << { 'check' => 'door_clearance', 'severity' => sev, 'room' => f['room'], 'value_mm' => mm.call(depth),
                        'limit_mm' => mm.call(depth), 'objects' => [ref.call(dr), ref.call(f)] }
          end
        end
      end
      kitchen = []
      if checks.include?('kitchen')
        objs.each do |o|
          next unless %w[EQ SN JN FN].include?(o['code']) && !o['room'].to_s.empty?
          kitchen << { 'id' => o['id'], 'name' => o['name'], 'def' => o['def'], 'tag' => o['tag'], 'code' => o['code'],
                       'room' => o['room'], 'x_mm' => to_mm(o['c'].x), 'y_mm' => to_mm(o['c'].y) }
        end
      end
      rooms = objs.map { |o| o['room'] }.uniq.reject { |r| r.to_s.empty? }
      { 'issues' => issues, 'kitchen_items' => kitchen, 'objects_checked' => objs.size, 'rooms' => rooms, 'checks' => checks,
        'walls_not_checked' => not_checked, 'not_checked' => skipped_checks, 'hidden' => ctx['skipped'].values }
    end

    # Text for word matching: NFC (macOS file names are NFD) and lower case (Unicode from Ruby 2.4, ASCII only before).
    def self.fold(s)
      t = utf8(s.to_s)
      t = t.unicode_normalize(:nfc) if t.respond_to?(:unicode_normalize)
      t.downcase
    rescue StandardError, LoadError # unicode_normalize loads its tables on first use
      s.to_s.downcase
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
