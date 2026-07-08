#!/usr/bin/env ruby
# frozen_string_literal: true

require 'yaml'

def usage
  warn 'Usage: render-public-egress-exceptions.rb <public-egress-exceptions.yaml> <networkpolicy.yaml> [networkpolicy.yaml ...]'
end

if ARGV.length < 2
  usage
  exit 2
end

exceptions_path = ARGV.shift
exceptions_doc = YAML.load_file(exceptions_path) || {}
exceptions = Array(exceptions_doc.dig('spec', 'ranges'))
if exceptions.empty?
  warn "#{exceptions_path}: spec.ranges must define the public egress exception CIDRs"
  exit 1
end

docs = []
replacement_count = 0

ARGV.each do |path|
  YAML.load_stream(File.read(path)) do |doc|
    next if doc.nil?

    if doc.is_a?(Hash) && doc['kind'] == 'NetworkPolicy'
      Array(doc.dig('spec', 'egress')).each do |rule|
        Array(rule && rule['to']).each do |peer|
          ip_block = peer.is_a?(Hash) ? peer['ipBlock'] : nil
          next unless ip_block.is_a?(Hash)
          next unless ip_block['cidr'] == '0.0.0.0/0'

          ip_block['except'] = exceptions.dup
          replacement_count += 1
        end
      end
    end

    docs << doc
  end
end

if replacement_count.zero?
  warn 'No public egress ipBlock entries were rendered'
  exit 1
end

puts YAML.dump_stream(*docs)
